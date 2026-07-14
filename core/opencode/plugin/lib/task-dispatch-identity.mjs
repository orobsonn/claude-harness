/** @description Strict task identity carried through the official Task prompt field. */

const OPEN = "[HARNESS_TASK_CONTEXT]";
const CLOSE = "[/HARNESS_TASK_CONTEXT]";
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

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

export default { parseTaskDispatchIdentity };
