/**
 * @description Pure decide for OC main-loop agent-idle-nudge (Task/agent family).
 * Mirrors CC parity but OC-native wording, distinct response/output idle check,
 * presence-only on agent_* keys (hasOwn), task-family name match.
 * Never throws; returns {action:'none'} or {action:'inject', context}.
 */

const NUDGE_CONTEXT =
  "Agent idle nudge: this Task dispatch returned without a final structured report. " +
  "Send EXACTLY ONE re-prompt to the same agent to extract its report — " +
  "do not send more than one, and do not re-dispatch the task/agent tool. " +
  "If the single re-prompt still yields no report, record the task as UNRESOLVED " +
  "and do NOT loop and do NOT re-dispatch.";

const CAPACITY_CONTEXT =
  "Provider capacity stop: this executor Task reached its step limit without an explicit hand verdict. " +
  "Preserve the in-scope diff and immediately consume the one available executor tier escalation; " +
  "do not ask the operator to restart the same hand and do not classify this as BLOCKED.";

/**
 * @param {unknown} v
 * @returns {boolean}
 */
function isIdle(v) {
  if (v == null) return true;
  if (typeof v !== "string") return false;
  return v.trim() === "";
}

/**
 * @param {unknown} payload
 * @param {unknown} [env]
 * @param {unknown} [deps]
 * @returns {{action:'none'} | {action:'inject', context: string}}
 */
export function decide(payload, env, deps) {
  try {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return { action: "none" };
    }
    const p = /** @type {Record<string, unknown>} */ (payload);
    if (!Object.prototype.hasOwnProperty.call(p, "tool_input") || typeof p.tool_input !== "object" || p.tool_input === null || Array.isArray(p.tool_input)) {
      return { action: "none" };
    }
    if (
      Object.prototype.hasOwnProperty.call(p, "agent_id") ||
      Object.prototype.hasOwnProperty.call(p, "agentId") ||
      Object.prototype.hasOwnProperty.call(p, "agentID")
    ) {
      return { action: "none" };
    }
    const tn = typeof p.tool_name === "string" ? p.tool_name.toLowerCase() : "";
    const isTaskFamily =
      tn === "task" ||
      tn === "agent" ||
      tn.endsWith(".task") ||
      tn.endsWith(".agent");
    if (!isTaskFamily) {
      return { action: "none" };
    }
    const handRole = typeof p.tool_input.subagent_type === "string" ? p.tool_input.subagent_type : "";
    const capacityText = [p.tool_response, p.tool_output].filter((value) => typeof value === "string").join("\n");
    if (/^(?:executor|sniper)-(?:low|medium|high)$/.test(handRole) && /\bmaximum steps reached\b/i.test(capacityText)) {
      return { action: "inject", context: CAPACITY_CONTEXT };
    }
    const idleResp = isIdle(p.tool_response);
    const idleOut = isIdle(p.tool_output);
    if (!idleResp || !idleOut) {
      return { action: "none" };
    }
    return { action: "inject", context: NUDGE_CONTEXT };
  } catch {
    return { action: "none" };
  }
}
