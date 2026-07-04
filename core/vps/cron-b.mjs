/**
 * @description VPS cron harness — Cron B, the review + AUTO-MERGE phase (task-7). Lists open
 * PRs, keeps only harness-originated ones (head branch starting with `harness/` — never a
 * human PR), skips a PR whose current head SHA was already reviewed (idempotent per head SHA),
 * and reads the machine-readable CLEAN/BLOCKED verdict block (core/vps/verdict-block.mjs) from
 * the PR body fetched FRESH at that reviewed head SHA — never a stale/cached body — so a
 * shipper's delivery-time CLEAN->BLOCKED downgrade is always respected. CLEAN + no open-risk
 * marker -> `gh pr ready` + `gh pr merge --squash` + a summary comment. BLOCKED, an absent
 * verdict block, or an open-risk marker -> a `gh pr comment` naming the blocking finding and
 * NEVER a merge.
 *
 * SCAFFOLD STUB (RED) — see cron-b.test.mjs for the 5 pinned assertions. Not yet implemented.
 *
 * @param {object} opts - Injected seams: gh, parseVerdictBlock, alreadyReviewed, recordReviewed,
 *   stateDir, openRiskMarker.
 * @returns {void}
 */
export function cronB(opts) {
  throw new Error("cronB: not implemented (task-7-cron-b-review-merge scaffold stub)");
}
