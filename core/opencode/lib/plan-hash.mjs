/** @description Deterministic semantic hash of a plan object, independent of JSON whitespace/key order.
 * Extracted from planner-artifact so planner-result can disambiguate candidate plans without
 * importing the fs/gate-state surface (which would create an import cycle).
 */

import crypto from "node:crypto";

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

/** @description Deterministic semantic hash independent of JSON whitespace/key order. */
export function semanticPlanHash(plan) {
  return crypto.createHash("sha256").update(JSON.stringify(stable(plan))).digest("hex");
}

export default { semanticPlanHash };
