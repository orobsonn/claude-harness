/** @description Disk gate-state with ownership-token RMW lock. OC shell only (fs). Shared pure patch lives in gate-state-shape. */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { mergeGateStatePatch } from "../../shared/lib/gate-state-shape.mjs";

/** Session id safe for path segment (no traversal). Aligned with OC session ids (ses_…). */
const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

/**
 * @description True when session id is safe as a single path segment.
 * @param {unknown} value
 * @returns {boolean}
 */
export function isSafeSessionIdSegment(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 128) {
    return false;
  }
  // Reject path traversal and separators before regex.
  if (value.includes("..") || value.includes("/") || value.includes("\\")) {
    return false;
  }
  return SAFE_SESSION_ID.test(value);
}

/**
 * @description Load gate-state.json from disk under `.opencode/plans/.state/`.
 * Requires explicit safe sessionId; explicit fail when missing (no cross-session mtime).
 * Fail-closed Result when unreadable. Never throws.
 * @param {string} projectRoot
 * @param {{ sessionId?: string | null }} [opts]
 * @returns {{ ok: true, state: unknown, path: string } | { ok: false, reason: string }}
 */
export function loadGateStateFromDisk(projectRoot, opts = {}) {
  try {
    const root =
      typeof projectRoot === "string" && projectRoot.length > 0
        ? projectRoot
        : process.cwd();
    if (typeof root !== "string" || root.length === 0) {
      return { ok: false, reason: "projectRoot missing" };
    }
    const stateRoot = path.join(root, ".opencode", "plans", ".state");
    const sessionId = opts.sessionId;

    /** @param {string} p */
    function readStateFile(p) {
      try {
        if (!fs.existsSync(p)) {
          // Missing file = empty ceremony (not yet classified), not infra failure.
          // Fail-closed on dual/plan still applies via empty dual_status / missing plan.
          return { ok: true, state: {}, path: p };
        }
        const raw = fs.readFileSync(p, "utf8");
        const state = JSON.parse(raw);
        if (state == null || typeof state !== "object" || Array.isArray(state)) {
          return {
            ok: false,
            reason: `gate-state invalid JSON object at ${p}`,
          };
        }
        return { ok: true, state, path: p };
      } catch (err) {
        return {
          ok: false,
          reason:
            err instanceof Error
              ? `gate-state-unreadable: ${err.message}`
              : "gate-state-unreadable",
        };
      }
    }

    if (sessionId != null && sessionId !== "") {
      if (!isSafeSessionIdSegment(sessionId)) {
        return { ok: false, reason: "unsafe sessionId" };
      }
      const p = path.join(
        stateRoot,
        /** @type {string} */ (sessionId),
        "gate-state.json",
      );
      return readStateFile(p);
    }
    return { ok: false, reason: "sessionId required for deterministic gate-state load" };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : "loadGateStateFromDisk failed",
    };
  }
}

export {
  LOCK_STALE_MS,
  LOCK_TIMEOUT_MS,
  lockPathFor,
  isPidAlive,
  readLockFile,
  compareAndDeleteLock,
  acquireLock,
  releaseLock,
} from "../../shared/lib/file-lock.mjs";
import { acquireLock, releaseLock } from "../../shared/lib/file-lock.mjs";

/**
 * @description Read gate-state JSON; {} on missing/error. Never throws.
 * @param {string} statePath
 * @returns {Record<string, unknown>}
 */
export function readGateState(statePath) {
  try {
    const raw = fs.readFileSync(statePath, "utf8");
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return {};
    }
    return parsed;
  } catch {
    return {};
  }
}

function readGateStateForMutation(statePath) {
  try {
    const raw = fs.readFileSync(statePath, "utf8");
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { ok: false, reason: "gate-state-invalid-object" };
    }
    return { ok: true, state: parsed };
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return { ok: true, state: {} };
    }
    return { ok: false, reason: "gate-state-unreadable" };
  }
}

/**
 * @description Atomic write (temp + rename). Never throws; returns boolean.
 * @param {string} statePath
 * @param {Record<string, unknown>} state
 * @returns {boolean}
 */
export function writeGateStateAtomic(statePath, state) {
  try {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    const tmp = `${statePath}.${process.pid}.${crypto.randomUUID().slice(0, 8)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
    fs.renameSync(tmp, statePath);
    return true;
  } catch {
    return false;
  }
}

/**
/** @description Under ownership-token lock: read → mergeGateStatePatch → atomic write → release.
 * @description Under ownership-token lock: read → mergeGateStatePatch → atomic write → release.
  * @description Under ownership-token lock: read → mergeGateStatePatch → atomic write → release.
 * @param {string} statePath
 * @param {Record<string, unknown>} patch
 * @param {{ timeoutMs?: number, staleMs?: number, now?: () => number, sleepMs?: (ms: number) => void }} [opts]
 * @returns {{ ok: true, state: Record<string, unknown> } | { ok: false, decision: "deny", reason: string }}
 */
export function mergeGateState(statePath, patch, opts = {}) {
  const acquired = acquireLock(statePath, opts);
  if (!acquired.ok) {
    return { ok: false, decision: "deny", reason: acquired.reason };
  }
  const token = acquired.token;
  try {
    const loaded = readGateStateForMutation(statePath);
    if (!loaded.ok) return { ok: false, decision: "deny", reason: loaded.reason };
    const prev = loaded.state;
    const applied = mergeGateStatePatch(prev, patch);
    if (!applied.ok) {
      return { ok: false, decision: "deny", reason: applied.reason ?? "patch-failed" };
    }
    if (!writeGateStateAtomic(statePath, applied.state)) {
      return { ok: false, decision: "deny", reason: "gate-state-write-failed" };
    }
    return { ok: true, state: applied.state };
  } finally {
    releaseLock(statePath, token);
  }
}

/**
 * @description Run fn under lock with current state; fn returns next state or patch result.
 * @param {string} statePath
 * @param {(prev: Record<string, unknown>) => Record<string, unknown> | { ok: false, reason: string }} fn
 * @param {{ timeoutMs?: number, staleMs?: number, now?: () => number, sleepMs?: (ms: number) => void }} [opts]
 * @returns {{ ok: true, state: Record<string, unknown> } | { ok: false, decision: "deny", reason: string }}
 */
export function withGateStateLock(statePath, fn, opts = {}) {
  const acquired = acquireLock(statePath, opts);
  if (!acquired.ok) {
    return { ok: false, decision: "deny", reason: acquired.reason };
  }
  const token = acquired.token;
  try {
    const loaded = readGateStateForMutation(statePath);
    if (!loaded.ok) return { ok: false, decision: "deny", reason: loaded.reason };
    const prev = loaded.state;
    let next;
    try {
      next = fn(prev);
    } catch {
      return { ok: false, decision: "deny", reason: "gate-state-fn-threw" };
    }
    if (next && typeof next === "object" && next.ok === false) {
      return { ok: false, decision: "deny", reason: String(next.reason ?? "fn-denied") };
    }
    const state = /** @type {Record<string, unknown>} */ (next);
    if (state === prev) return { ok: true, state };
    if (!writeGateStateAtomic(statePath, state)) {
      return { ok: false, decision: "deny", reason: "gate-state-write-failed" };
    }
    return { ok: true, state };
  } finally {
    releaseLock(statePath, token);
  }
}
