/** @description Unified same-agent retry budget (K attempts then product error). Never throws. */

/** Max dispatches of the same agent key before the host treats failure as terminal. */
export const AGENT_RETRY_K = 3;

/**
 * @description Stable key for retry accounting.
 * @param {unknown} role
 * @param {unknown} [taskId]
 * @returns {string}
 */
export function agentRetryKey(role, taskId = "") {
  const r = typeof role === "string" ? role.trim() : "";
  const t = typeof taskId === "string" ? taskId.trim() : "";
  if (!r) return "";
  return t ? `${r}::${t}` : r;
}

/**
 * @description Read failure count for a key from gate-state shaped object.
 * @param {unknown} state
 * @param {string} key
 * @returns {number}
 */
export function getAgentFailureCount(state, key) {
  if (!key) return 0;
  const map =
    state && typeof state === "object" && !Array.isArray(state)
      ? /** @type {Record<string, unknown>} */ (state).agent_dispatch_failures
      : null;
  if (!map || typeof map !== "object" || Array.isArray(map)) return 0;
  const n = Number(/** @type {Record<string, unknown>} */ (map)[key]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * @description Whether another dispatch of this agent key is allowed.
 * @param {unknown} state
 * @param {{ role?: unknown, taskId?: unknown, k?: number }} input
 * @returns {{ ok: true, remaining: number, failures: number } | { ok: false, reason: string, failures: number }}
 */
export function decideAgentRetryAllowed(state, input = {}) {
  const key = agentRetryKey(input.role, input.taskId);
  if (!key) return { ok: true, remaining: AGENT_RETRY_K, failures: 0 };
  const k = Number.isFinite(input.k) && input.k > 0 ? Math.floor(input.k) : AGENT_RETRY_K;
  const failures = getAgentFailureCount(state, key);
  if (failures >= k) {
    return {
      ok: false,
      failures,
      reason: `agent retry exhausted (${failures}/${k}) for ${key} — same agent failed ${k} times; treat as product error, do not ladder models`,
    };
  }
  return { ok: true, remaining: k - failures, failures };
}

/**
 * @description Apply success (reset) or failure (increment) for an agent key.
 * @param {unknown} previous
 * @param {{ role?: unknown, taskId?: unknown, outcome: "success" | "failure", k?: number }} input
 * @returns {{ state: Record<string, unknown>, key: string, failures: number, exhausted: boolean }}
 */
export function applyAgentDispatchOutcome(previous, input = {}) {
  const base =
    previous && typeof previous === "object" && !Array.isArray(previous)
      ? { .../** @type {Record<string, unknown>} */ (previous) }
      : {};
  const key = agentRetryKey(input.role, input.taskId);
  if (!key) return { state: base, key: "", failures: 0, exhausted: false };

  const prevMap =
    base.agent_dispatch_failures &&
    typeof base.agent_dispatch_failures === "object" &&
    !Array.isArray(base.agent_dispatch_failures)
      ? { .../** @type {Record<string, unknown>} */ (base.agent_dispatch_failures) }
      : {};
  const k = Number.isFinite(input.k) && input.k > 0 ? Math.floor(input.k) : AGENT_RETRY_K;

  if (input.outcome === "success") {
    delete prevMap[key];
    base.agent_dispatch_failures = prevMap;
    return { state: base, key, failures: 0, exhausted: false };
  }

  const next = getAgentFailureCount(base, key) + 1;
  prevMap[key] = next;
  base.agent_dispatch_failures = prevMap;
  base.agent_dispatch_last_failure = {
    key,
    at: new Date().toISOString(),
    failures: next,
    k,
  };
  return { state: base, key, failures: next, exhausted: next >= k };
}

export default {
  AGENT_RETRY_K,
  agentRetryKey,
  applyAgentDispatchOutcome,
  decideAgentRetryAllowed,
  getAgentFailureCount,
};
