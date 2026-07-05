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
 *   - `opts.reviewed.alreadyReviewed(prNumber, sha)` — same-sha detection seam: true when this
 *     exact PR head sha was already reviewed before (a re-enqueue whose repair session crashed
 *     or produced no new commit).
 *   - `opts.recordFindings(root, findings)` — writes the review findings where the NEXT repair
 *     session (dispatched back onto the same harness/<root> branch) reads them.
 *   - `opts.notify(event)` — fire-and-forget lifecycle notification (same event taxonomy as
 *     notify-telegram.mjs, e.g. `{ type: "blocked", issue, pr, reason }`).
 *   - `opts.findings` — the findings payload for THIS review, forwarded to recordFindings.
 *
 * Routing behavior:
 *   1. If the root's chain depth is already at the ceiling (cron-state's atCeiling, depth > 3),
 *      routing short-circuits straight to `harness:blocked` + a blocked notification, and NEVER
 *      resets the chain — a re-enqueue must never reset the ceiling back to zero.
 *   2. Otherwise the chain depth is incremented once per reject (fresh or same-sha) — a failed
 *      repair whose sha didn't change is never silently dropped, it still advances the chain.
 *   3. A fresh reject (sha changed) reuses the SAME harness/<root> issue/branch: no new issue is
 *      opened, the findings for this review are recorded for the repair session, and the issue is
 *      relabeled harness:in-review -> harness:ready so the cron re-dispatches it.
 *
 * All I/O (`gh`, the chain store, the reviewed-sha store, findings persistence, notification) is
 * injected as fakes, so these tests are fully hermetic and deterministic — no real gh/git process,
 * no real filesystem. The module under test (`./review-routing.mjs`) does not exist yet: these
 * tests are expected to fail RED until it is implemented against this pinned contract.
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

/** @description Fake same-sha detection seam. `sameShaResult` pins whether this sha was already reviewed. */
function makeFakeReviewed(sameShaResult = false) {
  const calls = [];
  return {
    alreadyReviewed(prNumber, sha) {
      calls.push([prNumber, sha]);
      return sameShaResult;
    },
    calls,
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

test("routeReject: fresh REJECT for issue 42 (pr headRefName harness/42) reuses the same harness/42 issue/branch, records the findings for the repair session, relabels harness:in-review -> harness:ready, and increments the chain counter exactly once — with no new issue opened", () => {
  const { gh, calls } = makeFakeGh();
  const chain = makeFakeChain({ atCeiling: () => false });
  const reviewed = makeFakeReviewed(false);
  const { recordFindings, calls: recordFindingsCalls } = makeFakeRecordFindings();
  const { notify } = makeFakeNotify();
  const findings = { summary: "fix the null check in payment handler" };

  const pr = { number: 501, headRefName: "harness/42" };
  const sha = "abc123";

  routeReject(pr, sha, { gh, chain, reviewed, recordFindings, notify, findings });

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

test("routeReject: a re-enqueued PR whose head sha is UNCHANGED since the last review (a failed/crashed repair) is never silently no-op'd — the chain counter advances toward the ceiling (or the PR routes straight to harness:blocked)", () => {
  const { gh, calls } = makeFakeGh();
  const chain = makeFakeChain({ atCeiling: () => false });
  const reviewed = makeFakeReviewed(true);
  const { recordFindings } = makeFakeRecordFindings();
  const { notify } = makeFakeNotify();

  const pr = { number: 501, headRefName: "harness/42" };
  const sha = "same-sha-as-last-review";

  routeReject(pr, sha, { gh, chain, reviewed, recordFindings, notify, findings: {} });

  assert.deepEqual(
    reviewed.calls,
    [[501, "same-sha-as-last-review"]],
    "routing must consult the injected same-sha detection seam for this pr/sha pair"
  );

  const blockedRelabel = findRelabelCall(calls, { removeLabel: "harness:in-review", addLabel: "harness:blocked" });
  const chainAdvanced = chain.incrementCalls.length >= 1;

  assert.ok(
    chainAdvanced || Boolean(blockedRelabel),
    "an unchanged-sha re-enqueue must never silently no-op: it must either increment the chain " +
      "counter toward the ceiling or relabel the issue straight to harness:blocked"
  );
});

test("routeReject: once the root-keyed chain depth is already at the ceiling (atCeiling(42) true), routing relabels harness:blocked and emits a blocked-type notification, keyed by the root issue 42, WITHOUT resetting the chain (a re-enqueue must never reset the ceiling)", () => {
  const { gh, calls } = makeFakeGh();
  const chain = makeFakeChain({ atCeiling: () => true });
  const reviewed = makeFakeReviewed(false);
  const { recordFindings } = makeFakeRecordFindings();
  const { notify, calls: notifyCalls } = makeFakeNotify();

  const pr = { number: 777, headRefName: "harness/42" };
  const sha = "whatever-sha";

  routeReject(pr, sha, { gh, chain, reviewed, recordFindings, notify, findings: {} });

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
