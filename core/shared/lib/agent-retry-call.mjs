/** @description Once-per-callId sticky outcome for agent retry (failure wins). Pure. */

/**
 * @param {Map<string, "success" | "failure">} map
 * @param {string} dedupeKey
 * @param {"success" | "failure"} outcome
 * @returns {{ apply: boolean, outcome: "success" | "failure" | null, undoSuccess: boolean }}
 */
export function decideCallOutcomeOnce(map, dedupeKey, outcome) {
  if (typeof dedupeKey !== "string" || !dedupeKey) {
    return { apply: false, outcome: null, undoSuccess: false };
  }
  const prev = map.get(dedupeKey);
  if (prev === outcome) return { apply: false, outcome: prev, undoSuccess: false };
  if (prev === "failure" && outcome === "success") {
    return { apply: false, outcome: "failure", undoSuccess: false };
  }
  if (prev === "success" && outcome === "failure") {
    map.set(dedupeKey, "failure");
    return { apply: true, outcome: "failure", undoSuccess: true };
  }
  map.set(dedupeKey, outcome);
  return { apply: true, outcome, undoSuccess: false };
}
