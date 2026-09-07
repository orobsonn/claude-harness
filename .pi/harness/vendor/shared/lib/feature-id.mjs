/** @description Shared safe ID validators for featureId, sessionId, taskId. Never throws. PathResult consumers only. */

export const SAFE_FEATURE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
export const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/
export const SAFE_TASK_ID = SAFE_FEATURE_ID

export function isSafeFeatureId(value) {
  return typeof value === 'string' && SAFE_FEATURE_ID.test(value)
}

export function isSafeSessionId(value) {
  if (typeof value !== 'string') return false
  if (value.length === 0 || value.length > 128) return false
  if (!SAFE_SESSION_ID.test(value)) return false
  if (value.includes('..')) return false
  return true
}

export function isSafeTaskId(value) {
  return isSafeFeatureId(value)
}
