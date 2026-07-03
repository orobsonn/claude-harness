/**
 * @description Machine-readable CLEAN/BLOCKED verdict block embedded in PR bodies so a
 * headless Cron B can decide "safe to merge?" without re-deriving delivery state from prose.
 * The block is delimited by OPEN_TAG/CLOSE_TAG; only text STRICTLY between those delimiters
 * is ever trusted — free prose elsewhere in the PR body (which may contain the literal words
 * "CLEAN"/"BLOCKED" for human-readable narrative) must never leak into the parsed verdict.
 *
 * Two shapes flow into formatVerdictBlock():
 *   - a plain verdict `{status: 'CLEAN'|'BLOCKED', finding?: string}` (round-trip case), or
 *   - a final-review STATE object `{securityVerdict, openRisk, orphanFreezeCommit,
 *     unresolvedBlockingAdversaryFinding, ...}` from which CLEAN/BLOCKED is DERIVED — any of
 *     securityVerdict === 'UNSAFE', openRisk, orphanFreezeCommit, or
 *     unresolvedBlockingAdversaryFinding forces BLOCKED; only the all-clear combination
 *     yields CLEAN.
 *
 * downgradeVerdictForDelivery() is the shipper's last-mile safety net: given the CLEAN/BLOCKED
 * block computed earlier plus a delivery-time signal (e.g. an orphan freeze-commit detected
 * right before push), it may DOWNGRADE CLEAN -> BLOCKED but must NEVER upgrade BLOCKED ->
 * CLEAN and must NEVER fabricate a downgrade absent a real delivery-time risk.
 */

/** @description Opening delimiter of the machine-readable verdict block. */
export const OPEN_TAG = "<!--harness:verdict-->";

/** @description Closing delimiter of the machine-readable verdict block. */
export const CLOSE_TAG = "<!--/harness:verdict-->";

/**
 * @description Formats a CLEAN/BLOCKED verdict (or derives one from a final-review state
 * object) into the delimited PR-body block string.
 * @param {{status: 'CLEAN'|'BLOCKED', finding?: string}|{securityVerdict?: 'SECURE'|'UNSAFE', openRisk?: boolean, orphanFreezeCommit?: boolean, unresolvedBlockingAdversaryFinding?: boolean}} input
 * @returns {string} the delimited verdict block (embeddable inside a larger PR body)
 */
export function formatVerdictBlock(input) {
  throw new Error("not implemented");
}

/**
 * @description Parses the delimited verdict block out of a full PR body. Only the text
 * strictly between OPEN_TAG and CLOSE_TAG is trusted; the status is read from a strict
 * `status:` field (never a substring scan), so a `finding` field containing the word "CLEAN"
 * can never flip the result. Any malformed shape (missing close tag, no valid status token)
 * fails closed — status is never 'CLEAN'.
 * @param {string} prBody
 * @returns {{status: 'CLEAN'|'BLOCKED', finding?: string}}
 */
export function parseVerdictBlock(prBody) {
  throw new Error("not implemented");
}

/**
 * @description Delivery-time, downgrade-only re-check of an already-formatted verdict block.
 * If the block is CLEAN and deliverySignal reports a real risk (orphan freeze-commit /
 * open-risk / critical-exception), re-emits the block as BLOCKED with the finding named.
 * Otherwise returns the block UNCHANGED — never upgrades BLOCKED to CLEAN, never fabricates a
 * downgrade absent a real delivery-time risk.
 * @param {string} block the delimited verdict block string
 * @param {{hasRisk: boolean, finding?: string}} deliverySignal
 * @returns {string} the (possibly downgraded) delimited verdict block
 */
export function downgradeVerdictForDelivery(block, deliverySignal) {
  throw new Error("not implemented");
}
