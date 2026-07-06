/**
 * @description VPS gate-machinery detection + merge-eligible conjunction (HR-9 + HR-10 / #ac-3.2).
 * A PR whose diff touches the harness's own gate machinery requires a SECOND independent
 * fresh-eyes pass before merge — observable at the ROUTING DECISION (second_pass_required flag),
 * and a BLOCKED 2nd pass forces awaiting-merge/blocked. The merge-eligible verdict is the
 * CONJUNCTION of fresh eyes AND cross-family AND (for gate diffs) the 2nd pass — a single
 * flaky CLEAN can never merge alone.
 */

/**
 * @description Directory-prefix globs identifying the harness control surface. ROOT-anchored and
 * segment-aligned: the trailing "/" guarantees a segment boundary, so a file matches only when its
 * path STARTS at the repo root with the glob (`vendor/core/vps/x` does NOT match). A PR whose diff
 * touches any of these — the harness's own delivery/gate machinery — is never auto-merged.
 */
const GATE_MACHINERY_DIR_GLOBS = [
  "core/vps/",
  "core/skills/",
  "core/agents/",
  "core/rules/",
  "core/hooks/",
  "core/modules/",
  ".github/",
];

/**
 * @description Basename globs identifying a control-surface FILE at any depth. Matched by exact
 * equality of the file's FINAL path segment (`a/b/CLAUDE.md` matches, `MYCLAUDE.mdx` and
 * `user-settings.json` do NOT — segment equality, never substring/prefix). `core/settings.json` and
 * `core/CLAUDE.md` are covered here by their basenames; `package.json` matches at any depth (a dep
 * change in any package is a supply-chain surface).
 */
const GATE_MACHINERY_BASENAMES = [
  "settings.json",
  "CLAUDE.md",
  "verdict-block",
  "package.json",
];

/**
 * @description True when a single changed-file path is on the harness control surface — a
 * directory-prefix root-anchored match OR a final-segment basename match. Never a bare startsWith on
 * a basename (which would leak `core/settings.json` past a root-only `settings.json` glob), never a
 * substring match.
 * @param {string} file — repo-relative path
 * @returns {boolean}
 */
function fileTouchesGateMachinery(file) {
  if (GATE_MACHINERY_DIR_GLOBS.some((glob) => file.startsWith(glob))) return true;
  const finalSegment = file.slice(file.lastIndexOf("/") + 1);
  return GATE_MACHINERY_BASENAMES.includes(finalSegment);
}

/**
 * @description Returns true when ANY entry in `changedFiles` is on the harness control surface.
 * Pure, synchronous, no I/O — `changedFiles` is caller-supplied (e.g. from the PR diff listing).
 * @param {string[]} changedFiles — repo-relative paths of files changed in the PR diff
 * @returns {boolean}
 */
export function touchesGateMachinery(changedFiles) {
  return changedFiles.some(fileTouchesGateMachinery);
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
