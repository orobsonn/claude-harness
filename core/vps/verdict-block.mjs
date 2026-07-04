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

const CLEAN_TOKEN = "CLEAN";
const BLOCKED_TOKEN = "BLOCKED";

/**
 * @description Fail-closed derivation of CLEAN/BLOCKED from a final-review state object — any
 * of an UNSAFE security verdict, an open risk, an orphan freeze-commit, or an unresolved
 * blocking adversary finding forces BLOCKED; only the all-clear combination yields CLEAN.
 * @param {{securityVerdict?: 'SECURE'|'UNSAFE', openRisk?: boolean, orphanFreezeCommit?: boolean, unresolvedBlockingAdversaryFinding?: boolean}} state
 * @returns {{status: 'CLEAN'|'BLOCKED'}}
 */
function deriveVerdictFromState(state) {
  const isBlocked =
    state.securityVerdict !== "SECURE" ||
    Boolean(state.openRisk) ||
    Boolean(state.orphanFreezeCommit) ||
    Boolean(state.unresolvedBlockingAdversaryFinding);
  return { status: isBlocked ? BLOCKED_TOKEN : CLEAN_TOKEN };
}

/** @description State/risk field names whose mere presence forces derivation over trust. */
const STATE_RISK_FIELDS = [
  "securityVerdict",
  "openRisk",
  "orphanFreezeCommit",
  "unresolvedBlockingAdversaryFinding",
];

/**
 * @description True if the input object carries any final-review state/risk field, regardless
 * of that field's value. A state object may ALSO carry a `status` key (e.g. forwarded verbatim
 * from an upstream step) — presence of a risk field always wins over a `status` key so a state
 * object can never skip fail-closed derivation just because it happens to also have `status`.
 * @param {object} obj
 * @returns {boolean}
 */
function carriesStateRiskFields(obj) {
  return STATE_RISK_FIELDS.some((field) => field in obj);
}

/**
 * @description Formats a CLEAN/BLOCKED verdict (or derives one from a final-review state
 * object) into the delimited PR-body block string. An input is trusted as a plain pre-formed
 * verdict ONLY when it has a `status` key AND none of the state/risk fields — any state/risk
 * field present forces fail-closed derivation via deriveVerdictFromState, even if `status` is
 * also present (never trust a literal `status` sitting alongside risk signals). A trusted
 * literal `status` is itself validated: anything other than exactly CLEAN or BLOCKED is
 * treated as BLOCKED.
 * @param {{status: 'CLEAN'|'BLOCKED', finding?: string}|{securityVerdict?: 'SECURE'|'UNSAFE', openRisk?: boolean, orphanFreezeCommit?: boolean, unresolvedBlockingAdversaryFinding?: boolean}} input
 * @returns {string} the delimited verdict block (embeddable inside a larger PR body)
 */
export function formatVerdictBlock(input) {
  const obj = input && typeof input === "object" ? input : {};

  let verdict;
  if ("status" in obj && !carriesStateRiskFields(obj)) {
    verdict =
      obj.status === CLEAN_TOKEN || obj.status === BLOCKED_TOKEN
        ? obj
        : { ...obj, status: BLOCKED_TOKEN };
  } else {
    verdict = deriveVerdictFromState(obj);
  }

  const lines = [OPEN_TAG, `status: ${verdict.status}`];
  if (verdict.status === BLOCKED_TOKEN && verdict.finding) {
    lines.push(`finding: ${verdict.finding}`);
  }
  lines.push(CLOSE_TAG);
  return lines.join("\n");
}

/**
 * @description Counts non-overlapping occurrences of a literal (non-regex) substring.
 * @param {string} haystack
 * @param {string} needle
 * @returns {number}
 */
function countLiteralOccurrences(haystack, needle) {
  if (!needle) return 0;
  return haystack.split(needle).length - 1;
}

/**
 * @description Parses the delimited verdict block out of a full PR body. The PR body is
 * editable by anyone who can push to the branch, so this parse must fail closed on any
 * ambiguity: a body is trustworthy ONLY when it contains EXACTLY one OPEN_TAG and EXACTLY one
 * CLOSE_TAG, in that order (a spoofed extra block — e.g. a prepended fake CLEAN block ahead of
 * the real BLOCKED one — must never win "first match wins"). Within that single well-formed
 * block, the status must be read from EXACTLY one `status:` line (never a substring scan, and
 * never "first status line wins" if more than one is present) — a `finding` field containing
 * the word "CLEAN", or a second injected `status:` line, must never flip the result. Any
 * malformed or ambiguous shape (zero or multiple delimiters, out-of-order delimiters, zero or
 * multiple status lines, or an unrecognized status value) fails closed — status is never
 * 'CLEAN' unless the block is unambiguous and its single status line is exactly CLEAN.
 * @param {string} prBody
 * @returns {{status: 'CLEAN'|'BLOCKED', finding?: string}}
 */
export function parseVerdictBlock(prBody) {
  const text = prBody ?? "";

  const openCount = countLiteralOccurrences(text, OPEN_TAG);
  const closeCount = countLiteralOccurrences(text, CLOSE_TAG);
  if (openCount !== 1 || closeCount !== 1) {
    // No block, or an ambiguous/duplicated block (e.g. a spoofed extra open/close pair
    // injected into the editable PR body) — fail closed rather than trust "first wins".
    return { status: BLOCKED_TOKEN };
  }

  const openIdx = text.indexOf(OPEN_TAG);
  const closeIdx = text.indexOf(CLOSE_TAG, openIdx + OPEN_TAG.length);
  if (closeIdx === -1) {
    // The single close tag sits before the single open tag — out of order, malformed.
    return { status: BLOCKED_TOKEN };
  }

  const body = text.slice(openIdx + OPEN_TAG.length, closeIdx);
  const statusMatches = [...body.matchAll(/^[ \t]*status:[ \t]*(.+?)[ \t]*$/gm)];
  if (statusMatches.length !== 1) {
    // Zero status lines, or more than one (e.g. an injected second `status:` line) — fail
    // closed rather than trust whichever line matched first.
    return { status: BLOCKED_TOKEN };
  }

  const statusToken = statusMatches[0][1].trim();
  if (statusToken === CLEAN_TOKEN) {
    return { status: CLEAN_TOKEN };
  }

  // Anything other than an unambiguous CLEAN token — including BLOCKED or garbage — is BLOCKED.
  const result = { status: BLOCKED_TOKEN };
  const findingMatch = body.match(/^[ \t]*finding:[ \t]*(.+?)[ \t]*$/m);
  if (findingMatch) {
    result.finding = findingMatch[1].trim();
  }
  return result;
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
  const parsed = parseVerdictBlock(block);
  if (parsed.status === CLEAN_TOKEN && deliverySignal && deliverySignal.hasRisk) {
    return formatVerdictBlock({ status: BLOCKED_TOKEN, finding: deliverySignal.finding });
  }
  return block;
}
