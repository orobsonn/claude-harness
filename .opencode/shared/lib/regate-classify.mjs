/**
 * @description Pure classifyRegatePending — absent fail-open, non-array fail-closed.
 * No fs.
 */

/**
 * @param {unknown} gateState
 * @returns {{ corrupt: false, pending: unknown[] } | { corrupt: true, raw: unknown }}
 */
export function classifyRegatePending(gateState) {
  const raw =
    gateState && typeof gateState === "object" && !Array.isArray(gateState)
      ? /** @type {Record<string, unknown>} */ (gateState).regate_pending
      : undefined;
  if (raw === undefined) return { corrupt: false, pending: [] };
  if (Array.isArray(raw)) return { corrupt: false, pending: raw };
  return { corrupt: true, raw };
}

/**
 * @param {unknown} raw
 * @returns {string}
 */
export function serializeRawRegatePending(raw) {
  let text;
  try {
    text = JSON.stringify(raw);
  } catch {
    try {
      text = String(raw);
    } catch {
      text = "<unserializable regate_pending>";
    }
  }
  if (text.length > 200) text = text.slice(0, 200);
  return text;
}

/**
 * @param {unknown} raw
 * @returns {string}
 */
export function corruptRegatePendingReason(raw) {
  const truncated = serializeRawRegatePending(raw);
  return (
    "[entry-gate] Blocked: gate-state corrupted — regate_pending is not a JSON array " +
    `(raw value: ${truncated}). Repair or delete gate-state.json (regate_pending must be a ` +
    "JSON array), then re-stamp the pending re-gate before proceeding."
  );
}
