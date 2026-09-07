/** @description Strict task identity carried through the official Task prompt field. */

const OPEN = "[HARNESS_TASK_CONTEXT]";
const CLOSE = "[/HARNESS_TASK_CONTEXT]";
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * @description Whether tool name is the OC Task/agent dispatch family.
 * Canonical rule shared by obs-hand and obs-eye: task | agent |
 * endsWith .task | .agent (case-insensitive).
 * @param {unknown} toolName
 * @returns {boolean}
 */
export function isTaskTool(toolName) {
  if (typeof toolName !== "string") return false;
  const n = toolName.toLowerCase();
  return (
    n === "task" ||
    n === "agent" ||
    n.endsWith(".task") ||
    n.endsWith(".agent")
  );
}

/**
 * @description Extract subagent_type from OC task tool args (best-effort).
 * Role sources only: subagent_type / agent* aliases (flat + nested input).
 * Never reads official Task `command` or `task_id` — those are host resume fields.
 * Never throws.
 * @param {unknown} toolArgs
 * @returns {string}
 */
export function extractSubagentType(toolArgs) {
  try {
    if (
      toolArgs == null ||
      typeof toolArgs !== "object" ||
      Array.isArray(toolArgs)
    ) {
      return "";
    }
    const a = /** @type {Record<string, unknown>} */ (toolArgs);
    const nested =
      a.input != null && typeof a.input === "object" && !Array.isArray(a.input)
        ? /** @type {Record<string, unknown>} */ (a.input)
        : null;
    const candidates = [
      a.subagent_type,
      a.subagentType,
      a.agent,
      a.agent_type,
      a.subagent,
      nested?.subagent_type,
      nested?.subagentType,
      nested?.agent,
      nested?.agent_type,
      nested?.subagent,
    ];
    for (const raw of candidates) {
      if (typeof raw === "string" && raw.trim().length > 0) return raw.trim();
    }
    return "";
  } catch {
    return "";
  }
}

/** @description Parse exactly one JSON task marker without accepting prose-like aliases. */
export function parseTaskDispatchIdentity(prompt) {
  if (typeof prompt !== "string") return { ok: false, reason: "task prompt marker missing" };
  const openCount = prompt.split(OPEN).length - 1;
  const closeCount = prompt.split(CLOSE).length - 1;
  if (openCount !== 1 || closeCount !== 1) return { ok: false, reason: "task prompt must contain exactly one complete task marker" };
  const first = prompt.indexOf(OPEN);
  const close = prompt.indexOf(CLOSE);
  if (first < 0 || close < first + OPEN.length) return { ok: false, reason: "task prompt marker delimiters are out of order" };
  const payload = prompt.slice(first + OPEN.length, close);
  const exact = payload.match(/^\s*\{\s*"task_id"\s*:\s*"((?:\\["\\/bfnrt]|\\u[0-9a-fA-F]{4}|[^"\\\u0000-\u001F])*)"\s*\}\s*$/);
  if (!exact) return { ok: false, reason: "task prompt marker must contain exactly one task_id string" };
  try {
    const taskId = JSON.parse(`"${exact[1]}"`);
    if (!TASK_ID.test(taskId)) {
      return { ok: false, reason: "task prompt marker has invalid task_id" };
    }
    return { ok: true, taskId };
  } catch {
    return { ok: false, reason: "task prompt marker task_id is invalid JSON" };
  }
}

export default { parseTaskDispatchIdentity, isTaskTool, extractSubagentType };
