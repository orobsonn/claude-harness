/** @description Path builders returning PathResult only. Never throws. Feature plans are stable across sessions. */

import {
  isSafeFeatureId,
  isSafeSessionId,
  isSafeTaskId
} from './feature-id.mjs'

/**
 * @param {"claude"|"opencode"} runtime
 */
export function runtimeDirName(runtime) {
  return runtime === 'opencode' ? '.opencode' : '.claude'
}

/** @param {unknown} roots */
function invalidRoots(roots) {
  if (!roots || typeof roots !== 'object' || Array.isArray(roots)) {
    return { ok: false, reason: 'invalid roots' }
  }
  return null
}

export function plansRoot(roots) {
  const bad = invalidRoots(roots)
  if (bad) return bad
  if (typeof roots.projectRoot !== 'string' || roots.projectRoot.length === 0) {
    return { ok: false, reason: 'invalid projectRoot' }
  }
  // runtimeDirName defaults non-opencode (incl. undefined) to .claude — only reject explicit junk
  if (
    roots.runtime != null &&
    roots.runtime !== 'claude' &&
    roots.runtime !== 'opencode'
  ) {
    return { ok: false, reason: 'invalid runtime' }
  }
  const dir = runtimeDirName(roots.runtime)
  return { ok: true, path: `${roots.projectRoot}/${dir}/plans` }
}

export function planDir(roots) {
  const bad = invalidRoots(roots)
  if (bad) return bad
  if (!roots.featureId || !isSafeFeatureId(roots.featureId)) {
    return { ok: false, reason: 'invalid featureId' }
  }
  const root = plansRoot(roots)
  if (!root.ok) return root
  return { ok: true, path: `${root.path}/${roots.featureId}` }
}

/** @description Stable feature plan path shared by Claude Code and OpenCode. */
export function executionPlanPath(roots) {
  const bad = invalidRoots(roots)
  if (bad) return bad
  if (!roots.featureId || !isSafeFeatureId(roots.featureId)) {
    return { ok: false, reason: 'invalid featureId' }
  }
  const root = plansRoot(roots)
  if (!root.ok) return root
  return { ok: true, path: `${root.path}/${roots.featureId}/execution-plan.json` }
}

export function gateStateDir(roots) {
  const bad = invalidRoots(roots)
  if (bad) return bad
  if (!roots.sessionId || !isSafeSessionId(roots.sessionId)) {
    return { ok: false, reason: 'invalid sessionId' }
  }
  const root = plansRoot(roots)
  if (!root.ok) return root
  return { ok: true, path: `${root.path}/.state/${roots.sessionId}` }
}

export function gateStatePath(roots) {
  const dir = gateStateDir(roots)
  if (!dir.ok) return dir
  return { ok: true, path: `${dir.path}/gate-state.json` }
}

export function handRecordPath(roots, taskId) {
  const bad = invalidRoots(roots)
  if (bad) return bad
  if (!roots.featureId || !isSafeFeatureId(roots.featureId)) {
    return { ok: false, reason: 'invalid featureId' }
  }
  if (!taskId || !isSafeTaskId(taskId)) {
    return { ok: false, reason: 'invalid taskId' }
  }
  if (typeof roots.projectRoot !== 'string' || roots.projectRoot.length === 0) {
    return { ok: false, reason: 'invalid projectRoot' }
  }
  if (roots.runtime === 'opencode') {
    if (!roots.sessionId || !isSafeSessionId(roots.sessionId)) {
      return { ok: false, reason: 'invalid sessionId' }
    }
    return { ok: true, path: `${roots.projectRoot}/.opencode/plans/.state/hand-records/${roots.featureId}/${roots.sessionId}/${taskId}.json` }
  }
  // claude legacy may omit session
  return { ok: true, path: `${roots.projectRoot}/.claude/plans/.state/hand-records/${roots.featureId}/${taskId}.json` }
}

export function sharedContextPath(roots) {
  const pd = planDir(roots)
  if (!pd.ok) return pd
  return { ok: true, path: `${pd.path}/shared_context.md` }
}

export function findingsPath(projectRoot) {
  if (typeof projectRoot !== 'string' || projectRoot.length === 0) {
    return { ok: false, reason: 'invalid projectRoot' }
  }
  return { ok: true, path: `${projectRoot}/findings.md` }
}
