/**
 * @description Scaffold stub for the review-session actuator (task-1 of review-spawn-wiring).
 * Exports the exact named symbols the frozen test imports so the runner collects >0 tests
 * (un-vacuuming the gate) while staying legitimately RED. The executor replaces both bodies
 * with the real implementation.
 */

/**
 * @description Derives the canonical merge verdict from the three eyes' raw outputs.
 * @param {object} eyes
 * @returns {{status: 'CLEAN'|'BLOCKED', finding?: string}}
 */
export function deriveCanonicalVerdict(eyes) {
  throw new Error("not implemented");
}

/**
 * @description Spawns the synchronous fresh-eyes review session and writes the Node-derived
 * canonical verdict artifact.
 * @param {{number: number, headSha: string}} pr
 * @param {{stateDir: string, changedFiles: string[], secondPass?: boolean}} meta
 * @param {object} deps
 * @returns {void}
 */
export function spawnReviewSession(pr, meta, deps) {
  throw new Error("not implemented");
}
