/**
 * @description VPS cron harness — merge + finalize step handed off from cron-b's auto-merge path,
 * plus a reconciliation pass that self-heals a harness issue whose PR merged while an upstream
 * relabel step (in-progress -> in-review -> awaiting-merge -> done) failed or was skipped.
 *
 * `mergeAndFinalize` performs the actual `gh pr merge --match-head-commit` TOCTOU-guarded merge
 * FIRST, and only relabels/resets/records-reviewed when that merge succeeds — a rejected merge
 * (head moved under the guard) must leave the PR re-reviewable on the next pass.
 *
 * `reconcile` scans the widened non-terminal label set for issues whose harness/<n> branch already
 * has a MERGED PR, and relabels them to harness:done — a self-heal for any relabel step that was
 * missed upstream. It is idempotent: a repeat pass only acts on issues still carrying a non-terminal
 * label.
 *
 * Every external seam (`gh`, `counter`, `recordReviewed`) is injected so this module is hermetic
 * under test and runtime-pluggable in production, following this repo's seam-injection style (see
 * cron-b.mjs, cron-state.mjs).
 */

/** @description Non-terminal harness labels scanned by reconcile() when opts.labels is not given. */
const DEFAULT_NON_TERMINAL_LABELS = ["harness:in-progress", "harness:in-review", "harness:awaiting-merge"];

/**
 * @description True when a `gh` seam result indicates success. Undefined/null or `{ok:false}` are
 * treated as failure — fail-closed.
 * @param {{ok?: boolean}|null|undefined} result
 * @returns {boolean}
 */
function isOk(result) {
  return Boolean(result && result.ok);
}

/**
 * @description Derives the harness issue number from a PR's head branch name (`harness/<digits>`).
 * @param {string} headRefName
 * @returns {number}
 */
function issueNumberFromHeadRefName(headRefName) {
  const match = /^harness\/(\d+)$/.exec(headRefName ?? "");
  if (!match) {
    throw new Error(`review-merge: cannot derive issue number from headRefName "${headRefName}"`);
  }
  return Number(match[1]);
}

/**
 * @description Merges a harness PR with the `--match-head-commit` TOCTOU guard, then finalizes the
 * issue (relabel -> reset counter -> record reviewed) only when the merge actually succeeded. A
 * rejected merge (the head moved under the guard) is left untouched so it stays re-reviewable.
 * @param {{number: number, headRefName: string}} pr
 * @param {string} sha head SHA cron-b already fetched fresh for this PR
 * @param {object} opts
 * @param {(args: string[]) => any} opts.gh injected `gh` seam
 * @param {{reset(issueNumber: number, o: {stateDir: string}): void}} opts.counter
 * @param {(pr: number, sha: string, o: {stateDir: string}) => void} opts.recordReviewed
 * @param {string} opts.stateDir
 * @returns {{merged: boolean}}
 */
export function mergeAndFinalize(pr, sha, opts) {
  const { gh, counter, recordReviewed, stateDir } = opts;

  const issueNumber = issueNumberFromHeadRefName(pr.headRefName);

  const mergeResult = gh(["pr", "merge", String(pr.number), "--squash", "--match-head-commit", sha]);

  if (!isOk(mergeResult)) {
    return { merged: false };
  }

  const relabelResult = gh(["issue", "edit", String(issueNumber), "--remove-label", "harness:in-review", "--add-label", "harness:done"]);
  counter.reset(issueNumber, { stateDir });
  if (isOk(relabelResult)) {
    recordReviewed(pr.number, sha, { stateDir });
  }

  return { merged: true };
}

/**
 * @description Self-heal pass: for each non-terminal harness label, finds issues still carrying it
 * whose harness/<n> branch already has a MERGED PR, and relabels those issues to harness:done. Only
 * acts on issues currently carrying a scanned label, so a repeat pass is a no-op.
 * @param {object} opts
 * @param {(args: string[]) => any} opts.gh injected `gh` seam
 * @param {{reset(issueNumber: number, o: {stateDir: string}): void}} opts.counter
 * @param {string} opts.stateDir
 * @param {string[]} [opts.labels] non-terminal labels to scan; defaults to the widened set
 * @returns {Array<{issue: number, from: string}>}
 */
export function reconcile(opts) {
  const { gh, counter, stateDir, labels = DEFAULT_NON_TERMINAL_LABELS } = opts;

  const reconciled = [];

  for (const label of labels) {
    const issues = gh(["issue", "list", "--label", label, "--json", "number,labels"]) || [];

    for (const issue of issues) {
      const number = issue.number;
      const mergedPrs = gh(["pr", "list", "--head", `harness/${number}`, "--state", "merged", "--json", "number,state"]) || [];

      if (mergedPrs.length === 0) {
        continue;
      }

      const openPrs = (gh(["pr", "list", "--head", `harness/${number}`, "--state", "open", "--json", "number,state"]) || []).filter(
        (openPr) => openPr.state !== "MERGED"
      );

      if (openPrs.length > 0) {
        continue;
      }

      const editResult = gh(["issue", "edit", String(number), "--remove-label", label, "--add-label", "harness:done"]);

      if (!isOk(editResult)) {
        continue;
      }

      counter.reset(number, { stateDir });
      reconciled.push({ issue: number, from: label });
    }
  }

  return reconciled;
}
