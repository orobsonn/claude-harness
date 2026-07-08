/**
 * @description Contract tests for review-routing.mjs (routeReject) — routes a review REJECT
 * verdict for a harness PR back into the retry loop instead of opening a brand-new issue/branch.
 *
 * Pinned contract: `routeReject(pr, sha, opts)`
 *   - `pr`  = `{ number: number, headRefName: "harness/<issue>" }` — the PR under review.
 *   - `sha` = the PR's current head commit SHA at review time.
 *   - `opts.gh(argv: string[])` — ordered gh-call seam (never a real gh/git process).
 *   - `opts.chain` — root-keyed chain-depth seam mirroring cron-state.mjs's contract:
 *       `increment(root)`, `atCeiling(root)`, `reset(root)`, `read(root)`.
 *   - `opts.reviewed.recordReviewed(prNumber, sha)` — records that this exact PR head sha was
 *     reviewed, called in BOTH routing branches (re-queue and chain-ceiling) BEFORE the relabel —
 *     a live sha is never left unrecorded, and a throw from this write must propagate and prevent
 *     the relabel from ever being issued.
 *   - `opts.recordFindings(root, findings)` — writes the review findings where the NEXT repair
 *     session (dispatched back onto the same harness/<root> branch) reads them.
 *   - `opts.notify(event)` — fire-and-forget lifecycle notification (same event taxonomy as
 *     notify-telegram.mjs, e.g. `{ type: "blocked", issue, pr, reason }`).
 *   - `opts.findings` — the findings payload for THIS review, forwarded to recordFindings.
 *
 * Routing behavior:
 *   1. If the root's chain depth is already at the ceiling (cron-state's atCeiling, depth > 3),
 *      routing records the reviewed sha, then short-circuits straight to `harness:blocked` + a
 *      blocked notification, and NEVER resets the chain — a re-enqueue must never reset the
 *      ceiling back to zero.
 *   2. Otherwise the chain depth is incremented once per reject (fresh or same-sha) — a failed
 *      repair whose sha didn't change is never silently dropped, it still advances the chain.
 *   3. A fresh reject (sha changed) records the reviewed sha, reuses the SAME harness/<root>
 *      issue/branch: no new issue is opened, the findings for this review are recorded for the
 *      repair session, and the issue is relabeled harness:in-review -> harness:ready so the cron
 *      re-dispatches it.
 *   4. In BOTH branches, `reviewed.recordReviewed` is called strictly BEFORE the relabel — if it
 *      throws, the throw propagates and no relabel is ever recorded.
 *
 * All I/O (`gh`, the chain store, the reviewed-sha store, findings persistence, notification) is
 * injected as fakes, so these tests are fully hermetic and deterministic — no real gh/git process,
 * no real filesystem. These tests are authored against the NEW recordReviewed contract and are
 * expected to fail RED until the production module is updated to match (it currently still calls
 * the old read-only `reviewed.alreadyReviewed` getter and discards its result).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { routeReject } from "./review-routing.mjs";

/** @description Fake gh seam. Records each `gh` argv (e.g. `["issue","edit",...]`) in order. */
function makeFakeGh() {
  const calls = [];
  function gh(args) {
    calls.push(args);
    return { ok: true };
  }
  return { gh, calls };
}

/**
 * @description Fake root-keyed chain-depth seam mirroring cron-state.mjs's
 * increment/atCeiling/reset/read contract. `atCeiling` is driven by an injectable predicate so a
 * test can pin "ceiling already reached" vs "still below ceiling" independently of real counts.
 * Tracks every call so a test can assert increment/reset call counts precisely.
 */
function makeFakeChain({ atCeiling = () => false } = {}) {
  const incrementCalls = [];
  const atCeilingCalls = [];
  const resetCalls = [];
  return {
    increment(root) {
      incrementCalls.push(root);
    },
    atCeiling(root) {
      atCeilingCalls.push(root);
      return atCeiling(root);
    },
    reset(root) {
      resetCalls.push(root);
    },
    read() {
      return 0;
    },
    incrementCalls,
    atCeilingCalls,
    resetCalls,
  };
}

/**
 * @description Fake reviewed-sha recording seam matching the NEW contract:
 * `recordReviewed(prNumber, sha)` is a write, not a read-only getter. Records every call in order.
 * When `throwOnRecord` is set, the call throws immediately after being recorded, so a test can
 * assert both that the throw propagates out of `routeReject` and that no relabel was issued
 * downstream of it.
 *
 * Also exposes a harmless no-op `alreadyReviewed` spy alongside `recordReviewed` — present so that
 * if production still calls the OLD read-only getter, the call is absorbed here (no TypeError) and
 * execution reaches the `recordReviewed` assertion below, turning a missing-method crash into a
 * true assertion-red rather than a broken-red.
 */
function makeFakeReviewed({ throwOnRecord = false } = {}) {
  const recordReviewedCalls = [];
  const alreadyReviewedCalls = [];
  return {
    recordReviewed(prNumber, sha) {
      recordReviewedCalls.push([prNumber, sha]);
      if (throwOnRecord) {
        throw new Error("review-routing: recordReviewed failed");
      }
    },
    alreadyReviewed(prNumber, sha) {
      alreadyReviewedCalls.push([prNumber, sha]);
      return false;
    },
    recordReviewedCalls,
    alreadyReviewedCalls,
  };
}

/** @description Fake findings-recording seam — captures (root, findings) pairs in call order. */
function makeFakeRecordFindings() {
  const calls = [];
  return {
    recordFindings(root, findings) {
      calls.push([root, findings]);
    },
    calls,
  };
}

/** @description Fake notify seam — captures each fired event in call order. */
function makeFakeNotify() {
  const calls = [];
  return {
    notify(event) {
      calls.push(event);
    },
    calls,
  };
}

/** @description Finds a `gh issue edit <n> --remove-label X --add-label Y` call in a calls log. */
function findRelabelCall(calls, { removeLabel, addLabel }) {
  return calls.find(
    (args) =>
      Array.isArray(args) &&
      args[0] === "issue" &&
      args[1] === "edit" &&
      args.includes("--remove-label") &&
      args[args.indexOf("--remove-label") + 1] === removeLabel &&
      args.includes("--add-label") &&
      args[args.indexOf("--add-label") + 1] === addLabel
  );
}

test("routeReject: fresh REJECT for issue 42 (pr headRefName harness/42) records the reviewed sha via reviewed.recordReviewed, reuses the same harness/42 issue/branch, records the findings for the repair session, relabels harness:in-review -> harness:ready, and increments the chain counter exactly once — with no new issue opened", () => {
  const { gh, calls } = makeFakeGh();
  const chain = makeFakeChain({ atCeiling: () => false });
  const reviewed = makeFakeReviewed();
  const { recordFindings, calls: recordFindingsCalls } = makeFakeRecordFindings();
  const { notify } = makeFakeNotify();
  const findings = { summary: "fix the null check in payment handler" };

  const pr = { number: 501, headRefName: "harness/42" };
  const sha = "abc123";

  routeReject(pr, sha, { gh, chain, reviewed, recordFindings, notify, findings });

  assert.deepEqual(
    reviewed.recordReviewedCalls,
    [[501, "abc123"]],
    "reviewed.recordReviewed must be called exactly once with the PR number and its head sha"
  );

  const issueCreateCall = calls.find((args) => Array.isArray(args) && args[0] === "issue" && args[1] === "create");
  assert.equal(issueCreateCall, undefined, "a fresh reject must never open a new issue — the same harness/42 is reused");

  const readyRelabel = findRelabelCall(calls, { removeLabel: "harness:in-review", addLabel: "harness:ready" });
  assert.ok(readyRelabel, "must relabel issue 42 from harness:in-review to harness:ready");
  assert.equal(readyRelabel[2], "42", "the relabel must target the SAME root issue 42 (harness/42 reused, not a new issue)");

  assert.equal(chain.incrementCalls.length, 1, "the chain counter must be incremented exactly once for this reject");
  assert.deepEqual(chain.incrementCalls, [42], "the chain counter must be incremented for root issue 42");

  assert.deepEqual(
    recordFindingsCalls,
    [[42, findings]],
    "the findings for issue 42 must be recorded where the next repair session reads them"
  );
});

test("routeReject: a re-enqueued PR whose head sha is UNCHANGED since the last review (a failed/crashed repair) is never silently no-op'd — reviewed.recordReviewed still records the sha, and the chain counter advances toward the ceiling (or the PR routes straight to harness:blocked)", () => {
  const { gh, calls } = makeFakeGh();
  const chain = makeFakeChain({ atCeiling: () => false });
  const reviewed = makeFakeReviewed();
  const { recordFindings } = makeFakeRecordFindings();
  const { notify } = makeFakeNotify();

  const pr = { number: 501, headRefName: "harness/42" };
  const sha = "same-sha-as-last-review";

  routeReject(pr, sha, { gh, chain, reviewed, recordFindings, notify, findings: {} });

  assert.deepEqual(
    reviewed.recordReviewedCalls,
    [[501, "same-sha-as-last-review"]],
    "reviewed.recordReviewed must be called for this pr/sha pair, even when the sha is unchanged from the last review"
  );

  const blockedRelabel = findRelabelCall(calls, { removeLabel: "harness:in-review", addLabel: "harness:blocked" });
  const chainAdvanced = chain.incrementCalls.length >= 1;

  assert.ok(
    chainAdvanced || Boolean(blockedRelabel),
    "an unchanged-sha re-enqueue must never silently no-op: it must either increment the chain " +
      "counter toward the ceiling or relabel the issue straight to harness:blocked"
  );
});

test("routeReject: once the root-keyed chain depth is already at the ceiling (atCeiling(42) true), routing records the reviewed sha via reviewed.recordReviewed, relabels harness:blocked and emits a blocked-type notification, keyed by the root issue 42, WITHOUT resetting the chain (a re-enqueue must never reset the ceiling)", () => {
  const { gh, calls } = makeFakeGh();
  const chain = makeFakeChain({ atCeiling: () => true });
  const reviewed = makeFakeReviewed();
  const { recordFindings } = makeFakeRecordFindings();
  const { notify, calls: notifyCalls } = makeFakeNotify();

  const pr = { number: 777, headRefName: "harness/42" };
  const sha = "zzz9";

  routeReject(pr, sha, { gh, chain, reviewed, recordFindings, notify, findings: {} });

  assert.deepEqual(
    reviewed.recordReviewedCalls,
    [[777, "zzz9"]],
    "reviewed.recordReviewed must be called exactly once with the PR number and its head sha"
  );

  const blockedRelabel = findRelabelCall(calls, { removeLabel: "harness:in-review", addLabel: "harness:blocked" });
  assert.ok(blockedRelabel, "must relabel harness:in-review -> harness:blocked once the chain ceiling is reached");
  assert.equal(blockedRelabel[2], "42", "the blocked relabel must target the root issue 42, not the PR number 777");

  assert.equal(notifyCalls.length, 1, "a notification must be emitted when routing hits the chain ceiling");
  assert.equal(notifyCalls[0].type, "blocked", "the emitted notification must be a blocked-type event");

  assert.deepEqual(
    chain.resetCalls,
    [],
    "the chain must NOT be reset here — a re-enqueue of an already-blocked PR must never reset the ceiling"
  );
});

test("routeReject: on the re-queue branch (atCeiling false), when reviewed.recordReviewed throws, the throw propagates out of routeReject and no gh issue-edit relabel to harness:ready is ever recorded — the record must strictly precede the relabel, so a live sha is never left unrecorded", () => {
  const { gh, calls } = makeFakeGh();
  const chain = makeFakeChain({ atCeiling: () => false });
  const reviewed = makeFakeReviewed({ throwOnRecord: true });
  const { recordFindings } = makeFakeRecordFindings();
  const { notify } = makeFakeNotify();

  const pr = { number: 501, headRefName: "harness/42" };
  const sha = "abc123";

  assert.throws(() => {
    routeReject(pr, sha, { gh, chain, reviewed, recordFindings, notify, findings: {} });
  });

  const readyRelabel = findRelabelCall(calls, { removeLabel: "harness:in-review", addLabel: "harness:ready" });
  assert.equal(
    readyRelabel,
    undefined,
    "no gh issue edit --add-label harness:ready may be recorded when reviewed.recordReviewed threw before reaching the relabel"
  );
});

test("routeReject: on the chain-ceiling branch (atCeiling true), when reviewed.recordReviewed throws, the throw propagates out of routeReject and no gh issue-edit relabel to harness:blocked is ever recorded — the record must strictly precede the relabel", () => {
  const { gh, calls } = makeFakeGh();
  const chain = makeFakeChain({ atCeiling: () => true });
  const reviewed = makeFakeReviewed({ throwOnRecord: true });
  const { recordFindings } = makeFakeRecordFindings();
  const { notify } = makeFakeNotify();

  const pr = { number: 777, headRefName: "harness/42" };
  const sha = "zzz9";

  assert.throws(() => {
    routeReject(pr, sha, { gh, chain, reviewed, recordFindings, notify, findings: {} });
  });

  const blockedRelabel = findRelabelCall(calls, { removeLabel: "harness:in-review", addLabel: "harness:blocked" });
  assert.equal(
    blockedRelabel,
    undefined,
    "no gh issue edit --add-label harness:blocked may be recorded when reviewed.recordReviewed threw before reaching the relabel"
  );
});
