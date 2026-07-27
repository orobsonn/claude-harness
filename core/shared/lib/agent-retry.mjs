/** @description Unified same-agent retry budget (K attempts then product error). Never throws. */

/** Max dispatches of the same agent key before the host treats failure as terminal. */
export const AGENT_RETRY_K = 3;

/**
 * Max dispatches of the same agent key that the harness's OWN gates may deny before the
 * host stops the loop. Kept in a separate namespace from AGENT_RETRY_K on purpose: a gate
 * deny says the dispatcher did not satisfy a precondition, never that the agent failed.
 * Charging it to the agent's budget permanently bans an agent that never ran — which is how
 * a cross-family review silently degraded to a single family.
 */
export const GATE_BLOCKED_DISPATCH_K = 3;

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
 * NOTE (#482): no production call site left in core/ — the OC entry-gate's in-session K=3 same-
 * agent retry brake that consumed this was removed and is not replaced (the real per-issue
 * ceiling lives in core/vps/cron-a-exit.mjs, outside the session). Kept for
 * applyAgentDispatchOutcome/applyGateBlockedDispatch (still active bookkeeping in loop-guard.ts)
 * and for AGENT_RETRY_K (still used by primary_failure_streak and PLANNER_SESSION_DISPATCH_CEILING)
 * — this specific decision function itself is exercised only by agent-retry.test.mjs now.
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
    // Stale last_failure outlived its counter and made forensics point at the wrong agent.
    const last = base.agent_dispatch_last_failure;
    if (last && typeof last === "object" && !Array.isArray(last) && last.key === key) {
      base.agent_dispatch_last_failure = null;
    }
    // A precondition that was later satisfied is not a standing failure. Without this the
    // gate-blocked counter is monotonic for the whole session — nothing anywhere deletes a key —
    // so K non-consecutive denials permanently ban a dispatch that now works. That is how a
    // planning-phase deadlock survived being reclassified out of the agent's own budget: the ban
    // just moved counters. The anti-runaway property is unchanged, because it is CONSECUTIVE
    // denials (a dispatcher that cannot satisfy the precondition never scores a success).
    const blockedMap =
      base.gate_blocked_dispatches &&
      typeof base.gate_blocked_dispatches === "object" &&
      !Array.isArray(base.gate_blocked_dispatches)
        ? { .../** @type {Record<string, unknown>} */ (base.gate_blocked_dispatches) }
        : null;
    if (blockedMap && key in blockedMap) {
      delete blockedMap[key];
      base.gate_blocked_dispatches = blockedMap;
      const lastBlocked = base.gate_blocked_last;
      if (lastBlocked && typeof lastBlocked === "object" && !Array.isArray(lastBlocked) && lastBlocked.key === key) {
        base.gate_blocked_last = null;
      }
    }
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

/**
 * @description Read how many times the harness's own gates denied this dispatch key.
 * @param {unknown} state
 * @param {string} key
 * @returns {number}
 */
export function getGateBlockedCount(state, key) {
  if (!key) return 0;
  const map =
    state && typeof state === "object" && !Array.isArray(state)
      ? /** @type {Record<string, unknown>} */ (state).gate_blocked_dispatches
      : null;
  if (!map || typeof map !== "object" || Array.isArray(map)) return 0;
  const n = Number(/** @type {Record<string, unknown>} */ (map)[key]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * @description Whether another dispatch is allowed given prior harness-gate denials.
 * Bounded like the agent budget, but in its own namespace and with a dispatcher-facing reason.
 * NOTE (#482): no production call site left in core/ — see decideAgentRetryAllowed's note above;
 * applyGateBlockedDispatch (still called from loop-guard.ts) keeps writing the counter this reads,
 * but nothing calls this decision function anymore outside agent-retry.test.mjs.
 * @param {unknown} state
 * @param {{ role?: unknown, taskId?: unknown, k?: number }} input
 * @returns {{ ok: true, remaining: number, blocked: number } | { ok: false, reason: string, blocked: number }}
 */
export function decideGateBlockedDispatchAllowed(state, input = {}) {
  const key = agentRetryKey(input.role, input.taskId);
  if (!key) return { ok: true, remaining: GATE_BLOCKED_DISPATCH_K, blocked: 0 };
  const k = Number.isFinite(input.k) && input.k > 0 ? Math.floor(input.k) : GATE_BLOCKED_DISPATCH_K;
  const blocked = getGateBlockedCount(state, key);
  if (blocked >= k) {
    return {
      ok: false,
      blocked,
      reason: `harness gate denied ${key} ${blocked}/${k} times — the dispatch precondition was never satisfied; fix the precondition, do not re-dispatch`,
    };
  }
  return { ok: true, remaining: k - blocked, blocked };
}

/**
 * @description Record one harness-gate denial for a dispatch key, outside the agent's retry budget.
 * @param {unknown} previous
 * @param {{ role?: unknown, taskId?: unknown, reason?: unknown, k?: number }} input
 * @returns {{ state: Record<string, unknown>, key: string, blocked: number, exhausted: boolean }}
 */
export function applyGateBlockedDispatch(previous, input = {}) {
  const base =
    previous && typeof previous === "object" && !Array.isArray(previous)
      ? { .../** @type {Record<string, unknown>} */ (previous) }
      : {};
  const key = agentRetryKey(input.role, input.taskId);
  if (!key) return { state: base, key: "", blocked: 0, exhausted: false };

  const prevMap =
    base.gate_blocked_dispatches &&
    typeof base.gate_blocked_dispatches === "object" &&
    !Array.isArray(base.gate_blocked_dispatches)
      ? { .../** @type {Record<string, unknown>} */ (base.gate_blocked_dispatches) }
      : {};
  const k = Number.isFinite(input.k) && input.k > 0 ? Math.floor(input.k) : GATE_BLOCKED_DISPATCH_K;
  const next = getGateBlockedCount(base, key) + 1;
  prevMap[key] = next;
  base.gate_blocked_dispatches = prevMap;
  base.gate_blocked_last = {
    key,
    at: new Date().toISOString(),
    blocked: next,
    k,
    ...(typeof input.reason === "string" && input.reason ? { reason: input.reason.slice(0, 280) } : {}),
  };
  return { state: base, key, blocked: next, exhausted: next >= k };
}

export default {
  AGENT_RETRY_K,
  GATE_BLOCKED_DISPATCH_K,
  agentRetryKey,
  applyAgentDispatchOutcome,
  applyGateBlockedDispatch,
  decideAgentRetryAllowed,
  decideGateBlockedDispatchAllowed,
  getAgentFailureCount,
  getGateBlockedCount,
};
