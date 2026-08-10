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

import { STATE_LABELS } from "./review-labels.mjs";
import { decideMergeChecks } from "../shared/lib/merge-check-gate.mjs";

/** @description Non-terminal harness labels scanned by reconcile() when opts.labels is not given. */
const DEFAULT_NON_TERMINAL_LABELS = ["harness:in-progress", "harness:in-review", "harness:awaiting-merge"];

/**
 * @description The full set of lifecycle state labels stripped when an issue transitions to
 * harness:done — the shared STATE_LABELS plus the terminal harness:awaiting-merge. Removing the whole
 * set (not just the one scanned/current label) guarantees no residual state label leaks onto a done
 * issue (the defect that left a stray harness:ready alongside harness:done and re-triggered select).
 */
const DONE_STRIP_LABELS = [...STATE_LABELS, "harness:awaiting-merge"];

/**
 * @description Builds the `gh issue edit` argv that strips EVERY lifecycle state label and adds
 * harness:done — mutually exclusive by construction, and it never touches domain labels (tier/kaizen/
 * priority) because it only ever names harness:* state labels.
 * @param {number|string} issueNumber
 * @returns {string[]}
 */
function relabelToDoneArgs(issueNumber) {
  const args = ["issue", "edit", String(issueNumber)];
  for (const label of DONE_STRIP_LABELS) args.push("--remove-label", label);
  args.push("--add-label", "harness:done");
  return args;
}

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
 * @description Blocks synchronously for `ms` milliseconds without a subprocess — used to space out
 * merge retries while GitHub finishes computing mergeability. Injectable via `mergeAndFinalize`'s
 * `sleep` opt so tests pass a no-op and never actually wait.
 * @param {number} ms
 */
function defaultSleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
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
 * @description Reads the PR's current merge-state classification. Returns the `mergeStateStatus`
 * string (e.g. "BEHIND", "DIRTY", "CLEAN") or "" when the view call failed/was malformed. `gh pr
 * view --json` returns a parsed object on success or `[]` (fail-closed) on failure — an array or
 * a falsy value both yield "".
 * @param {(args: string[]) => any} gh
 * @param {number} prNumber
 * @returns {string}
 */
function mergeStateStatusOf(gh, prNumber) {
  const view = gh(["pr", "view", String(prNumber), "--json", "mergeStateStatus,mergeable"]);
  if (!view || Array.isArray(view)) return "";
  return typeof view.mergeStateStatus === "string" ? view.mergeStateStatus : "";
}

/**
 * @description Reads one exact PR's GitHub check rollup through the injected `gh` boundary.
 * An unavailable/malformed response stays null and the shared policy denies it.
 * @param {(args: string[]) => any} gh
 * @param {number} prNumber
 * @returns {unknown}
 */
function mergeChecksOf(gh, prNumber) {
  const view = gh(["pr", "view", String(prNumber), "--json", "statusCheckRollup"]);
  if (!view || Array.isArray(view) || typeof view !== "object") return null;
  return view.statusCheckRollup;
}

/**
 * @description Merges a harness PR with the `--match-head-commit` TOCTOU guard, then finalizes the
 * issue (relabel -> reset counters -> record reviewed) only when the merge actually succeeded.
 *
 * A merge that fails after the mergeability retries is CLASSIFIED, not immediately given up on. A
 * branch that is only BEHIND its base (a "require branches up to date" protection, common once
 * auto-merge lands more PRs onto main) is auto-recovered with GitHub's native, non-force
 * `gh pr update-branch`: that changes the head sha, so the review cron re-reviews the PR from
 * scratch next cycle (alreadyReviewed is keyed by sha) before re-attempting the merge — no new
 * "fix and re-merge" pipeline, just the existing loop re-triggered. An update-attempt CEILING keeps
 * two PRs that keep invalidating each other from looping forever. Any other failure (a real content
 * conflict, a head that moved, checks blocked) is TERMINAL and routes to manual merge upstream.
 * @param {{number: number, headRefName: string}} pr
 * @param {string} sha head SHA cron-b already fetched fresh for this PR
 * @param {object} opts
 * @param {(args: string[]) => any} opts.gh injected `gh` seam
 * @param {{reset(issueNumber: number, o: {stateDir: string}): void, readUpdateAttempts(pr: number, o: {stateDir: string}): number, incrementUpdateAttempt(pr: number, o: {stateDir: string}): void, resetUpdateAttempts(pr: number, o: {stateDir: string}): void}} opts.counter
 * @param {(pr: number, sha: string, o: {stateDir: string}) => void} opts.recordReviewed
 * @param {string} opts.stateDir
 * @param {number} [opts.maxUpdateAttempts] update-branch retry ceiling (default 3)
 * @returns {{merged: boolean, updateAttempted?: boolean, checksRetryable?: boolean, terminal?: boolean}}
 */
/**
 * @description Classifies a merge that failed after the mergeability retries and, for the only
 * auto-recoverable case, acts on it. A branch that is only BEHIND its base (a "require branches up
 * to date" protection) is refreshed with GitHub's native, non-force `gh pr update-branch` — bounded
 * by an update-attempt ceiling so two mutually-invalidating PRs cannot loop forever. Everything else
 * (real conflict, head moved, checks blocked, an unreadable merge-state) is terminal. Fail-closed:
 * any non-BEHIND status routes to manual merge.
 * @param {{number: number}} pr
 * @param {{gh: (args: string[]) => any, counter: object, stateDir: string, maxUpdateAttempts: number}} o
 * @returns {{terminal: true} | {updateAttempted: true, terminal: false}}
 */
function classifyFailedMerge(pr, { gh, counter, stateDir, maxUpdateAttempts }) {
  if (mergeStateStatusOf(gh, pr.number) !== "BEHIND") {
    return { terminal: true };
  }
  if (counter.readUpdateAttempts(pr.number, { stateDir }) >= maxUpdateAttempts) {
    return { terminal: true };
  }
  const updateResult = gh(["pr", "update-branch", String(pr.number)]);
  if (!isOk(updateResult)) {
    // A real conflict surfaced while merging the base into the head — terminal, human resolves it.
    return { terminal: true };
  }
  counter.incrementUpdateAttempt(pr.number, { stateDir });
  // The head sha changes under update-branch, so the review cron re-reviews the PR at its new sha
  // next cycle before re-attempting the merge — hence NO recordReviewed / NO relabel here.
  return { updateAttempted: true, terminal: false };
}

export function mergeAndFinalize(pr, sha, opts) {
  const { gh, counter, recordReviewed, stateDir, sleep = defaultSleep, maxMergeAttempts = 3, maxUpdateAttempts = 3 } = opts;

  const issueNumber = issueNumberFromHeadRefName(pr.headRefName);

  // The official cron path must prove CI green immediately before it asks GitHub to merge. This
  // is intentionally one read and one pure decision: no cache, poller, or duplicate policy.
  const checkDecision = decideMergeChecks(mergeChecksOf(gh, pr.number));
  if (!checkDecision.ok) {
    if (checkDecision.state === "pending" || checkDecision.state === "unavailable") {
      return { merged: false, checksRetryable: true, terminal: false };
    }
    return { merged: false, terminal: true, mergeBlockedByChecks: true };
  }

  // GitHub computes mergeability ASYNCHRONOUSLY; right after the review pass it can still be
  // "unknown" (computing), which makes the first `gh pr merge` fail transiently even for a
  // clean, eligible PR. Retry a few times with a short gap so an otherwise-mergeable PR merges on
  // THIS cron pass instead of waiting a whole cycle (the SHA is not recorded on failure, so a real
  // rejection still stays re-reviewable). The `--match-head-commit` guard keeps the retry safe: a
  // head that actually moved fails every attempt rather than merging stale code.
  let mergeResult;
  for (let attempt = 0; attempt < maxMergeAttempts; attempt++) {
    if (attempt > 0) sleep(2000);
    mergeResult = gh(["pr", "merge", String(pr.number), "--squash", "--match-head-commit", sha]);
    if (isOk(mergeResult)) break;
  }

  if (!isOk(mergeResult)) {
    return { merged: false, ...classifyFailedMerge(pr, { gh, counter, stateDir, maxUpdateAttempts }) };
  }

  const relabelResult = gh(relabelToDoneArgs(issueNumber));
  counter.reset(issueNumber, { stateDir });
  counter.resetUpdateAttempts(pr.number, { stateDir });
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

      const editResult = gh(relabelToDoneArgs(number));

      if (!isOk(editResult)) {
        continue;
      }

      counter.reset(number, { stateDir });
      reconciled.push({ issue: number, from: label });
    }
  }

  return reconciled;
}
