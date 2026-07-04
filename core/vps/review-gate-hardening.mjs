/**
 * @description VPS gate-machinery detection + merge-eligible conjunction (HR-9 + HR-10 / #ac-3.2).
 * A PR whose diff touches the harness's own gate machinery requires a SECOND independent
 * fresh-eyes pass before merge — observable at the ROUTING DECISION (second_pass_required flag),
 * and a BLOCKED 2nd pass forces awaiting-merge/blocked. The merge-eligible verdict is the
 * CONJUNCTION of fresh eyes AND cross-family AND (for gate diffs) the 2nd pass — a single
 * flaky CLEAN can never merge alone.
 */

/**
 * @description Glob patterns that identify the harness's own gate machinery. A PR whose diff
 * touches any of these paths requires a second independent fresh-eyes pass before merge.
 */
const GATE_MACHINERY_GLOBS = [
  "core/vps/",
  "core/skills/",
  "core/agents/",
  "core/rules/",
  "verdict-block",
  "settings.json",
  "CLAUDE.md",
];

/**
 * @description Returns true when ANY entry in `changedFiles` matches a gate-machinery glob.
 * Pure, synchronous, no I/O — `changedFiles` is caller-supplied (e.g. from the PR diff listing).
 * @param {string[]} changedFiles — repo-relative paths of files changed in the PR diff
 * @returns {boolean}
 */
export function touchesGateMachinery(changedFiles) {
  return changedFiles.some((file) =>
    GATE_MACHINERY_GLOBS.some((glob) => file.startsWith(glob))
  );
}

/**
 * @description The merge-eligible conjunction. `second_pass_required` is echoed straight through
 * from `inputs.secondPassRequired` so it is observable on the returned routing decision (callers
 * derive `secondPassRequired` from `touchesGateMachinery(changedFiles)` before calling
 * `mergeEligible`).
 *
 * `eligible` is:
 *   eligible = freshVerdictClean
 *     && crossFamilyEligible
 *     && (secondPassRequired ? secondPassClean : true)
 *
 * A single flaky fresh CLEAN is NEVER sufficient on its own — cross-family eligibility is always
 * required, and gate-machinery diffs additionally require a CLEAN second independent pass.
 * @param {{freshVerdictClean: boolean, crossFamilyEligible: boolean, secondPassRequired: boolean, secondPassClean: boolean}} inputs
 * @returns {{eligible: boolean, second_pass_required: boolean}}
 */
export function mergeEligible(inputs) {
  const { freshVerdictClean, crossFamilyEligible, secondPassRequired, secondPassClean } = inputs;

  const eligible =
    freshVerdictClean &&
    crossFamilyEligible &&
    (secondPassRequired ? secondPassClean : true);

  return { eligible, second_pass_required: secondPassRequired };
}
