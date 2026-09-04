/** @description Construtores de caminho da lane Pi. Espelha core/shared/lib/path-helpers.mjs (runtime OC),
 * mas com raiz própria `.pi/harness/` (estado em `.pi/harness/state/`, planos em `.pi/harness/plans/`).
 * Mesmo contrato PathResult ({ok:true,path} | {ok:false,reason}) e as mesmas reason strings. Nunca lança.
 * NUNCA usar core/shared/lib/path-helpers.mjs na lane Pi — ele só conhece `.claude`/`.opencode`. */

import {
  isSafeFeatureId,
  isSafeSessionId,
  isSafeTaskId
} from '../../shared/lib/feature-id.mjs'

/** @param {unknown} roots */
function invalidRoots(roots) {
  if (!roots || typeof roots !== 'object' || Array.isArray(roots)) {
    return { ok: false, reason: 'invalid roots' }
  }
  return null
}

/** @param {unknown} roots */
function invalidProjectRoot(roots) {
  if (typeof roots.projectRoot !== 'string' || roots.projectRoot.length === 0) {
    return { ok: false, reason: 'invalid projectRoot' }
  }
  return null
}

/** @description Raiz de planos da lane Pi: <projectRoot>/.pi/harness/plans */
export function piPlansRoot(root) {
  if (typeof root !== 'string' || root.length === 0) {
    return { ok: false, reason: 'invalid projectRoot' }
  }
  return { ok: true, path: `${root}/.pi/harness/plans` }
}

/** @description Raiz de estado da lane Pi: <projectRoot>/.pi/harness/state */
export function piStateRoot(root) {
  if (typeof root !== 'string' || root.length === 0) {
    return { ok: false, reason: 'invalid projectRoot' }
  }
  return { ok: true, path: `${root}/.pi/harness/state` }
}

/** @description Diretório do plano de uma feature: <plansRoot>/<featureId> */
export function piPlanDir(roots) {
  const bad = invalidRoots(roots)
  if (bad) return bad
  // Precedência idêntica à do OC (path-helpers.planDir): featureId antes de projectRoot.
  if (!roots.featureId || !isSafeFeatureId(roots.featureId)) {
    return { ok: false, reason: 'invalid featureId' }
  }
  const root = piPlansRoot(roots.projectRoot)
  if (!root.ok) return root
  return { ok: true, path: `${root.path}/${roots.featureId}` }
}

/** @description Plano de execução estável da feature: <plansRoot>/<featureId>/execution-plan.json */
export function piExecutionPlanPath(roots) {
  const dir = piPlanDir(roots)
  if (!dir.ok) return dir
  return { ok: true, path: `${dir.path}/execution-plan.json` }
}

/** @description Especificação humana canônica da feature, revisada antes do planner. */
export function piSpecPath(roots) {
  const dir = piPlanDir(roots)
  if (!dir.ok) return dir
  return { ok: true, path: `${dir.path}/spec.md` }
}

/** @description Diretório de estado da sessão: <stateRoot>/<sessionId> */
export function piGateStateDir(roots) {
  const bad = invalidRoots(roots)
  if (bad) return bad
  // Precedência idêntica à do OC (path-helpers.gateStateDir): sessionId antes de projectRoot.
  if (!roots.sessionId || !isSafeSessionId(roots.sessionId)) {
    return { ok: false, reason: 'invalid sessionId' }
  }
  const root = piStateRoot(roots.projectRoot)
  if (!root.ok) return root
  return { ok: true, path: `${root.path}/${roots.sessionId}` }
}

/** @description Gate-state da sessão: <stateRoot>/<sessionId>/gate-state.json */
export function piGateStatePath(roots) {
  const dir = piGateStateDir(roots)
  if (!dir.ok) return dir
  return { ok: true, path: `${dir.path}/gate-state.json` }
}

/** @description Hand-record: <stateRoot>/hand-records/<featureId>/<sessionId>/<taskId>.json */
export function piHandRecordPath(roots, taskId) {
  const bad = invalidRoots(roots)
  if (bad) return bad
  // Precedência idêntica à do OC (path-helpers.handRecordPath, ramo opencode):
  // featureId → taskId → projectRoot → sessionId.
  if (!roots.featureId || !isSafeFeatureId(roots.featureId)) {
    return { ok: false, reason: 'invalid featureId' }
  }
  if (!taskId || !isSafeTaskId(taskId)) {
    return { ok: false, reason: 'invalid taskId' }
  }
  const badRoot = invalidProjectRoot(roots)
  if (badRoot) return badRoot
  if (!roots.sessionId || !isSafeSessionId(roots.sessionId)) {
    return { ok: false, reason: 'invalid sessionId' }
  }
  const root = piStateRoot(roots.projectRoot)
  if (!root.ok) return root
  return { ok: true, path: `${root.path}/hand-records/${roots.featureId}/${roots.sessionId}/${taskId}.json` }
}

/** @description Diretório de dispatch-records do pai: <stateRoot>/<parentSessionId>/dispatch-records */
export function piDispatchRecordDir(roots) {
  const bad = invalidRoots(roots)
  if (bad) return bad
  // Mesma precedência de piGateStateDir (builder chaveado por sessão): id antes de projectRoot.
  if (!roots.parentSessionId || !isSafeSessionId(roots.parentSessionId)) {
    return { ok: false, reason: 'invalid sessionId' }
  }
  const root = piStateRoot(roots.projectRoot)
  if (!root.ok) return root
  return { ok: true, path: `${root.path}/${roots.parentSessionId}/dispatch-records` }
}
