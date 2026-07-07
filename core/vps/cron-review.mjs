/**
 * @description Node layer of the independent PR-review phase: lists open PRs, origin-gates them
 * via review-origin-gate.mjs (isReviewEligible — the SINGLE self-contained eligibility source),
 * checks pr:sha idempotency, spawns the reviewing-pull-requests session, reads the
 * engine-controlled verdict artifact, enforces the merge conjunction at the boundary
 * (fresh CLEAN AND cross-family — HR-2 / #ac-2.3), and drives per-cycle reconciliation (HR-3 / #ac-7.1).
 *
 * Reads the PR diff via `gh pr diff <n>` / `gh api` (or a detached SHA worktree) and NEVER
 * checks out branch harness/<N> — no worktree collision with a concurrent repair (HR-7).
 *
 * Every external seam is injected so this module is hermetic under test and runtime-pluggable
 * in production, following this repo's seam-injection style (see cron-b.mjs, cron-state.mjs).
 */
import { STATE_LABELS } from "./review-labels.mjs";

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
 * @param {(pr: object, meta: object) => void} opts.spawnReviewSession
 * @param {(event: object) => void} opts.notify
 * @param {string} opts.stateDir engine-controlled review state directory
 * @param {string} opts.authenticatedUser gh-user login for the origin gate
 * @param {(pr: object) => boolean} opts.engineKnows cross-check for secondary origin signal
 * @param {(o: {stateDir: string}) => void} opts.recordReviewSession breaker increment
 * @param {(o: {stateDir: string}) => boolean} opts.breakerTripped windowed-cap gate
 * @param {(pr: number, sha: string, o: {stateDir: string}) => boolean} opts.alreadyReviewed
 * @param {(pr: number, sha: string, o: {stateDir: string}) => void} opts.recordReviewed idempotency handoff for the awaiting-merge route
 * @param {(pr: number, sha: string, o: {stateDir: string}) => void} opts.incrementInfraFailure per-pr:sha count of review sessions that crashed without a verdict
 * @param {(pr: number, sha: string, o: {stateDir: string}) => boolean} opts.atInfraFailureCeiling true once the infra-failure count for this pr:sha has reached the ceiling
 * @param {boolean} [opts.autoMergeEnabled] - only strict `=== true` auto-merges eligible PRs; default/false routes to awaiting-merge
 * @returns {Promise<void>}
 */
export async function cronReview(opts) {
  const {
    gh,
    isReviewEligible,
    getFreshVerdict,
    crossFamilyEligible,
    mergeAndFinalize,
    reconcile,
    routeReject,
    spawnReviewSession,
    notify,
    stateDir,
    authenticatedUser,
    engineKnows,
    recordReviewSession,
    breakerTripped,
    alreadyReviewed,
    recordReviewed,
    incrementInfraFailure,
    atInfraFailureCeiling,
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

  /**
   * @description Shared terminal-CLEAN "manual merge" route. Ensures the awaiting-merge label exists,
   * UNDRAFTS the PR (`gh pr ready` — headless PRs are drafts; undrafting gives the operator a
   * one-click merge on a non-draft PR; idempotent and a failure never aborts the route), strips every
   * lifecycle STATE label and adds harness:awaiting-merge in ONE mutually-exclusive relabel (domain
   * labels preserved because only harness:* state labels are named), records the review as terminal
   * (so a same-SHA re-review is a no-op — the PR is not re-processed every cycle), and notifies.
   * Reused by the autoMerge-off route, the cross-family-absent residual, and the
   * permanent-merge-failure route (AC-1.4).
   * @param {object} pr
   * @param {string} sha
   * @param {{ notifyType?: string }} [o]
   */
  function routeToAwaitingMerge(pr, sha, { notifyType = "pr-awaiting-merge" } = {}) {
    ensureAwaitingMergeLabel();
    gh(["pr", "ready", String(pr.number)]);
    const root = extractRoot(pr.headRefName);
    if (root !== null) {
      const args = ["issue", "edit", String(root)];
      for (const label of STATE_LABELS) args.push("--remove-label", label);
      args.push("--add-label", "harness:awaiting-merge");
      gh(args);
    }
    recordReviewed(pr.number, sha, { stateDir });
    notify({ type: notifyType, pr: pr.number, url: pr.url });
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
    // spawn) so a non-dev operator sees the review begin, not only its outcome. AWAITED here so the
    // send actually completes while the event loop is free: the next line is a blocking spawnSync
    // that would otherwise stall the event loop for minutes, expiring the send's AbortSignal timeout
    // before its promise ever settles — the review-started ping would silently never arrive.
    await notify({ type: "review-started", pr: number, url: pr.url });

    // Spawn the review session, then record it for the breaker cap.
    spawnReviewSession(pr, { stateDir, changedFiles });
    recordReviewSession({ stateDir });

    // Fresh verdict from the engine-controlled artifact (HR-5 / #ac-2.1).
    const verdict = getFreshVerdict(pr, sha, stateDir);

    // The review session produced NO verdict artifact — it crashed / timed out, NOT a real BLOCKED.
    // Do NOT routeReject: that re-queues the WHOLE issue for an expensive from-scratch re-dispatch over
    // a finding that does not exist. Count this per pr:sha and let the NEXT (cheap) review cycle retry
    // the review of this same PR — until a per-pr:sha ceiling, then block the issue + notify the operator.
    if (verdict === null) {
      incrementInfraFailure(number, sha, { stateDir });
      if (atInfraFailureCeiling(number, sha, { stateDir })) {
        gh(["label", "create", "harness:blocked", "--force"]);
        const root = extractRoot(pr.headRefName);
        if (root !== null) gh(["issue", "edit", String(root), "--add-label", "harness:blocked"]);
        recordReviewed(number, sha, { stateDir }); // stop re-reviewing this dead sha
        notify({ type: "pr-review-infra-blocked", pr: number, url: pr.url });
      }
      // else: alreadyReviewed is deliberately NOT recorded, so the next cycle retries the review.
      continue;
    }

    const freshVerdictClean = Boolean(verdict && verdict.status === "CLEAN");

    // Cross-family eligibility (HR-2 / #ac-2.3).
    const crossFamilyOk = crossFamilyEligible(pr, { changedFiles, sha, stateDir });

    // Merge-eligible = fresh CLEAN AND cross-family. A flaky CLEAN alone never merges because
    // cross-family is always required. A change to the harness's own engine is treated like any
    // other PR — one clean review is enough; there is no separate control-surface carve-out.
    const eligible = freshVerdictClean && crossFamilyOk;

    // Route at the composition decision boundary. Every routine outcome notifies the operator so a
    // non-dev never has to poll GitHub to learn what the autonomous review did (HR: observability).
    if (eligible) {
      if (autoMergeEnabled === true && changedFiles.length > 0) {
        // Fail-CLOSED on an empty/unknown changed-file set: a genuinely empty diff, or a malformed
        // (non-array) `gh pr diff` that already collapsed to [] above, must never slip onto the
        // auto-merge path — no visibility into what changed. An empty diff routes to manual merge instead.
        // Undraft BEFORE the merge — a headless PR is a draft and `gh pr merge` cannot merge a draft;
        // the undraft is idempotent and its failure never aborts the merge.
        gh(["pr", "ready", String(pr.number)]);
        const mergeOutcome = mergeAndFinalize(pr, sha, { gh, stateDir }) || {};
        if (mergeOutcome.merged) {
          notify({ type: "pr-merged", pr: pr.number, url: pr.url });
        } else if (mergeOutcome.updateAttempted && !mergeOutcome.terminal) {
          // Branch was only BEHIND its base: mergeAndFinalize ran GitHub's native (non-force)
          // update-branch, which changes the head sha. Do NOT relabel and do NOT recordReviewed — the
          // review loop re-picks this PR up next cycle at its new sha (alreadyReviewed is keyed by sha)
          // and re-reviews it from scratch before re-attempting the merge. Progress notify only, never
          // the pr-merge-failed "needs a human" signal.
          notify({ type: "pr-branch-updated-retry", pr: pr.number, url: pr.url });
        } else {
          // Permanent merge failure (real conflict / head moved / update-branch ceiling) — route to
          // manual merge as a genuinely TERMINAL state (routeToAwaitingMerge records the review) so it
          // is not re-reviewed and re-merge-attempted every cycle.
          routeToAwaitingMerge(pr, sha, { notifyType: "pr-merge-failed" });
        }
      } else {
        // Eligible but the rollout lock is OFF — route to manual merge (undraft + awaiting-merge).
        routeToAwaitingMerge(pr, sha);
      }
    } else if (!freshVerdictClean) {
      // Fresh verdict is not CLEAN — reject (advance chain, re-queue or block). routeReject owns its
      // own notify (chain-ceiling blocked); a plain re-queue is reported by the fix session's own run.
      routeReject(pr, sha, { gh, stateDir, findings: verdict });
    } else {
      // Residual: fresh CLEAN but cross-family absent/ineligible — route to harness:awaiting-merge.
      routeToAwaitingMerge(pr, sha);
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
