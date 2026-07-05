/**
 * @description Node layer of the independent PR-review phase: lists open PRs, origin-gates them
 * via review-origin-gate.mjs (isReviewEligible — the SINGLE self-contained eligibility source),
 * checks pr:sha idempotency, spawns the reviewing-pull-requests session, reads the
 * engine-controlled verdict artifact, enforces the merge conjunction at the boundary
 * (HR-9 / #ac-2.3 + #ac-3.2), and drives per-cycle reconciliation (HR-3 / #ac-7.1).
 *
 * Reads the PR diff via `gh pr diff <n>` / `gh api` (or a detached SHA worktree) and NEVER
 * checks out branch harness/<N> — no worktree collision with a concurrent repair (HR-7).
 *
 * Every external seam is injected so this module is hermetic under test and runtime-pluggable
 * in production, following this repo's seam-injection style (see cron-b.mjs, cron-state.mjs).
 */
import { join } from "node:path";

/**
 * @description Extracts the root issue number from a `harness/<N>` branch name.
 * @param {string} headRefName
 * @returns {number|null}
 */
function extractRoot(headRefName) {
  const match = /^harness\/(\d+)$/.exec(headRefName ?? "");
  return match ? Number(match[1]) : null;
}

/**
 * @description Runs one review-cycle pass: lists open PRs, origin-gates them, reviews each
 * eligible unreviewed PR, and drives reconciliation independent of the open-PR loop.
 * See file header for the full safety contract.
 *
 * @param {object} opts
 * @param {(args: string[]) => any} opts.gh injected `gh` seam
 * @param {(pr: object, o: {authenticatedUser: string, engineKnows: Function}) => boolean} opts.isReviewEligible
 * @param {(pr: object, sha: string, stateDir: string) => {status: string, finding?: string}|null} opts.getFreshVerdict
 * @param {(pr: object, o: {changedFiles: string[], sha: string, stateDir: string}) => boolean} opts.crossFamilyEligible pre-bound cross-family eligibility check
 * @param {(pr: object, sha: string, o: object) => {merged: boolean}} opts.mergeAndFinalize
 * @param {() => Array<{issue: number, from: string}>} opts.reconcile zero-arg reconciliation driver
 * @param {(pr: object, sha: string, o: object) => void} opts.routeReject
 * @param {(changedFiles: string[]) => boolean} opts.touchesGateMachinery
 * @param {(inputs: {freshVerdictClean: boolean, crossFamilyEligible: boolean, secondPassRequired: boolean, secondPassClean: boolean}) => {eligible: boolean, second_pass_required: boolean}} opts.mergeEligible
 * @param {(pr: object, meta: object) => void} opts.spawnReviewSession
 * @param {(event: object) => void} opts.notify
 * @param {string} opts.stateDir engine-controlled review state directory
 * @param {string} opts.authenticatedUser gh-user login for the origin gate
 * @param {(pr: object) => boolean} opts.engineKnows cross-check for secondary origin signal
 * @param {(o: {stateDir: string}) => void} opts.recordReviewSession breaker increment
 * @param {(o: {stateDir: string}) => boolean} opts.breakerTripped windowed-cap gate
 * @param {(pr: number, sha: string, o: {stateDir: string}) => boolean} opts.alreadyReviewed
 * @param {(pr: number, sha: string, o: {stateDir: string}) => void} opts.recordReviewed idempotency handoff for the awaiting-merge and 2nd-pass-blocked routes
 * @param {boolean} [opts.autoMergeEnabled] - only strict `=== true` auto-merges eligible PRs; default/false routes to awaiting-merge
 * @returns {void}
 */
export function cronReview(opts) {
  const {
    gh,
    isReviewEligible,
    getFreshVerdict,
    crossFamilyEligible,
    mergeAndFinalize,
    reconcile,
    routeReject,
    touchesGateMachinery,
    mergeEligible,
    spawnReviewSession,
    notify,
    stateDir,
    authenticatedUser,
    engineKnows,
    recordReviewSession,
    breakerTripped,
    alreadyReviewed,
    recordReviewed,
    autoMergeEnabled,
  } = opts;

  // `gh pr list --json` exposes the head SHA as `headRefOid` (there is NO `headSha` field — an
  // invalid field makes gh exit non-zero, which normalizeGhResult turns into `[]`, silently
  // blanking the whole review cycle). Fetch `headRefOid` and normalize it onto `headSha` so every
  // downstream consumer (and the frozen test fakes, which supply `headSha`) keeps working.
  const prs = (gh(["pr", "list", "--json", "number,headRefName,headRefOid,author,labels,url", "--state", "open"]) || [])
    .map((pr) => (pr && pr.headSha == null && pr.headRefOid != null ? { ...pr, headSha: pr.headRefOid } : pr));

  // Track whether the harness:awaiting-merge label has been ensured to exist.
  // The idempotent `gh label create --force` runs BEFORE the first relabel to that label
  // so a fail-closed route never fails on a missing label (mirrors cron-a-select.mjs:57).
  let awaitingMergeLabelEnsured = false;

  /**
   * @description Idempotent label-create for harness:awaiting-merge — runs at most once per cycle,
   * before the first relabel to that label.
   */
  function ensureAwaitingMergeLabel() {
    if (!awaitingMergeLabelEnsured) {
      gh(["label", "create", "harness:awaiting-merge", "--force"]);
      awaitingMergeLabelEnsured = true;
    }
  }

  for (const pr of prs) {
   try {
    // Origin gate — single self-contained eligibility source (review-origin-gate.mjs).
    if (!isReviewEligible(pr, { authenticatedUser, engineKnows })) {
      continue;
    }

    const number = pr.number;
    const sha = pr.headSha;

    // Idempotency: a PR already reviewed at its current head SHA is a no-op.
    if (alreadyReviewed(number, sha, { stateDir })) {
      continue;
    }

    // Read the diff via `gh pr diff <n> --name-only` — NEVER checkout branch harness/<N>.
    const rawDiff = gh(["pr", "diff", String(number), "--name-only"]);
    if (rawDiff && rawDiff.diffFailed) {
      notify({ type: "pr-diff-fetch-failed", pr: number, url: pr.url });
      continue;
    }
    const changedFiles = Array.isArray(rawDiff) ? rawDiff : [];

    // Circuit-breaker gate BEFORE spawning the review session (HR-8 / #ac-6.2).
    if (breakerTripped({ stateDir })) {
      notify({ type: "breaker-stall", pr: number });
      continue;
    }

    // Tell the operator a fresh-eyes analysis is starting (before the multi-minute synchronous
    // spawn) so a non-dev operator sees the review begin, not only its outcome.
    notify({ type: "review-started", pr: number, url: pr.url });

    // Spawn the review session, then record it for the breaker cap.
    spawnReviewSession(pr, { stateDir, changedFiles });
    recordReviewSession({ stateDir });

    // Fresh verdict from the engine-controlled artifact (HR-5 / #ac-2.1).
    const verdict = getFreshVerdict(pr, sha, stateDir);
    const freshVerdictClean = Boolean(verdict && verdict.status === "CLEAN");

    // Cross-family eligibility (HR-2 / #ac-2.3).
    const crossFamilyOk = crossFamilyEligible(pr, { changedFiles, sha, stateDir });

    // Gate-machinery 2nd pass (HR-9 / #ac-3.2).
    const secondPassRequired = touchesGateMachinery(changedFiles);
    let secondPassClean = true;
    if (secondPassRequired) {
      const secondPassStateDir = join(stateDir, "second-pass");
      spawnReviewSession(pr, { stateDir: secondPassStateDir, changedFiles, secondPass: true });
      recordReviewSession({ stateDir });
      const secondVerdict = getFreshVerdict(pr, sha, secondPassStateDir);
      secondPassClean = Boolean(secondVerdict && secondVerdict.status === "CLEAN");
    }

    // Merge-eligible conjunction (HR-9): fresh-CLEAN AND cross-family AND (gate diff → 2nd-pass CLEAN).
    const decision = mergeEligible({
      freshVerdictClean,
      crossFamilyEligible: crossFamilyOk,
      secondPassRequired,
      secondPassClean,
    });

    // Route at the composition decision boundary. Every routine outcome notifies the operator so a
    // non-dev never has to poll GitHub to learn what the autonomous review did (HR: observability).
    if (decision.eligible) {
      if (autoMergeEnabled === true) {
        // All conditions met — merge.
        const { merged } = mergeAndFinalize(pr, sha, { gh, stateDir }) || {};
        if (merged) {
          notify({ type: "pr-merged", pr: pr.number, url: pr.url });
        }
      } else {
        // Auto-merge rollout lock is OFF — route to harness:awaiting-merge.
        ensureAwaitingMergeLabel();
        const root = extractRoot(pr.headRefName);
        if (root !== null) {
          gh(["issue", "edit", String(root), "--add-label", "harness:awaiting-merge"]);
        }
        recordReviewed(pr.number, sha, { stateDir });
        notify({ type: "pr-awaiting-merge", pr: pr.number, url: pr.url });
      }
    } else if (!freshVerdictClean) {
      // Fresh verdict is not CLEAN — reject (advance chain, re-queue or block). routeReject owns its
      // own notify (chain-ceiling blocked); a plain re-queue is reported by the fix session's own run.
      routeReject(pr, sha, { gh, stateDir, findings: verdict });
    } else if (secondPassRequired && !secondPassClean) {
      // Gate-machinery diff whose 2nd pass is BLOCKED — route to harness:blocked.
      gh(["label", "create", "harness:blocked", "--force"]);
      const root = extractRoot(pr.headRefName);
      if (root !== null) {
        gh(["issue", "edit", String(root), "--add-label", "harness:blocked"]);
      }
      recordReviewed(pr.number, sha, { stateDir });
      notify({ type: "pr-blocked", pr: pr.number, reason: "gate-machinery 2nd-pass BLOCKED", url: pr.url });
    } else {
      // Residual: cross-family absent/ineligible — route to harness:awaiting-merge.
      // Ensure the label exists BEFORE the first relabel (fail-closed route never fails on a missing label).
      ensureAwaitingMergeLabel();
      const root = extractRoot(pr.headRefName);
      if (root !== null) {
        gh(["issue", "edit", String(root), "--add-label", "harness:awaiting-merge"]);
      }
      recordReviewed(pr.number, sha, { stateDir });
      notify({ type: "pr-awaiting-merge", pr: pr.number, url: pr.url });
    }
   } catch (err) {
    // Isolate one PR's failure — a throw here must not skip the remaining PRs or reconcile().
    notify({ type: "pr-review-error", pr: pr.number, message: err instanceof Error ? err.message : String(err) });
    continue;
   }
  }

  // Reconciliation driver (HR-3 / #ac-7.1): invoked EVERY cycle, independent of the open-PR loop,
  // so operator manual-merge / transient-relabel self-heal actually has a per-cycle caller.
  reconcile();
}
