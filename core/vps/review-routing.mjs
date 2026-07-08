/**
 * @description Reject / chain-depth routing for the independent PR-review phase. A review REJECT
 * for a harness PR never opens a new issue/branch — it routes back onto the SAME `harness/<root>`
 * issue so the repair session picks up where it left off, and it advances a root-keyed chain-depth
 * counter (mirroring cron-state.mjs's increment/atCeiling/reset/read contract) that eventually caps
 * a chronically-failing issue at `harness:blocked` instead of looping forever.
 */

const HARNESS_BRANCH_PATTERN = /^harness\/(\d+)$/;

/**
 * @description Extracts the root issue number from a `harness/<issue>` branch name.
 * @param {string} headRefName
 * @returns {number}
 */
function extractRootIssue(headRefName) {
  const match = HARNESS_BRANCH_PATTERN.exec(headRefName ?? "");
  if (!match) {
    throw new Error(`review-routing: unrecognized harness branch name "${headRefName}"`);
  }
  return Number(match[1]);
}

/**
 * @description Relabels the root issue via the injected `gh` seam.
 * @param {(argv: string[]) => unknown} gh
 * @param {number} root
 * @param {string} removeLabel
 * @param {string} addLabel
 * @returns {void}
 */
function relabelIssue(gh, root, removeLabel, addLabel) {
  gh(["issue", "edit", String(root), "--remove-label", removeLabel, "--add-label", addLabel]);
}

/**
 * @description Routes a review REJECT verdict for a harness PR: relabels straight to
 * `harness:blocked` once the root's chain depth is already at the ceiling (never resetting the
 * chain), otherwise advances the chain depth once and re-queues the SAME `harness/<root>`
 * issue/branch — recording the review findings for the next repair session and relabeling
 * `harness:in-review` -> `harness:ready` so the cron re-dispatches it. A re-enqueue whose head sha
 * is unchanged since the last review (a failed/crashed repair) still advances the chain instead of
 * being silently dropped.
 * @param {{ number: number, headRefName: string }} pr
 * @param {string} sha
 * @param {object} opts
 * @param {(argv: string[]) => unknown} opts.gh
 * @param {{ increment(root: number): void, atCeiling(root: number): boolean, reset(root: number): void, read(root: number): number }} opts.chain
 * @param {{ alreadyReviewed(prNumber: number, sha: string): boolean, recordReviewed(prNumber: number, sha: string): void }} opts.reviewed
 * @param {(root: number, findings: unknown) => void} opts.recordFindings
 * @param {(event: object) => void} opts.notify
 * @param {unknown} opts.findings
 * @returns {void}
 */
export function routeReject(pr, sha, opts) {
  const { gh, chain, reviewed, recordFindings, notify, findings } = opts;
  const root = extractRootIssue(pr.headRefName);

  if (chain.atCeiling(root)) {
    reviewed.recordReviewed(pr.number, sha);
    relabelIssue(gh, root, "harness:in-review", "harness:blocked");
    notify({ type: "blocked", issue: root, pr: pr.number, reason: "chain-ceiling" });
    return;
  }

  reviewed.recordReviewed(pr.number, sha);

  chain.increment(root);
  recordFindings(root, findings);
  relabelIssue(gh, root, "harness:in-review", "harness:ready");
}
