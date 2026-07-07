/**
 * @description Frozen contract tests for the automerge-hardening changes to cron-review.mjs:
 *   - AC-1.1  undraft (gh pr ready) runs BEFORE the merge on the auto-merge path.
 *   - AC-1.2  undraft also runs on the CLEAN awaiting-merge route (autoMerge-off), and NEVER on a
 *             reject route.
 *   - AC-1.3  a failed gh pr ready does not abort the merge.
 *   - AC-1.4  mergeAndFinalize returns {merged:false} -> awaiting-merge + recordReviewed + pr-merge-failed.
 *   - AC-2.1  a harness-engine diff is treated like any other PR — a CLEAN one auto-merges (no
 *             control-surface carve-out, no 2nd pass); an empty/unknown diff still fails closed.
 *   - AC-2.2  a CLEAN non-engine PR auto-merges (common path not regressed).
 *   - AC-3.2  the awaiting-merge relabel strips exactly the STATE_LABELS set and preserves domain labels.
 * Hermetic: every gh/notify/mergeAndFinalize seam is an injected fake; the REAL isReviewEligible is
 * used so a mis-routed origin-gate input is caught by real gate logic.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { cronReview } from "./cron-review.mjs";
import { isReviewEligible } from "./review-origin-gate.mjs";

function makeFakeGh({ readyResult = { ok: true } } = {}) {
  const calls = [];
  const prs = new Map();
  const diffs = new Map();
  function gh(args) {
    calls.push(args);
    if (args[0] === "pr" && args[1] === "list") return [...prs.values()];
    if (args[0] === "pr" && args[1] === "diff") return diffs.get(Number(args[2])) ?? [];
    if (args[0] === "pr" && args[1] === "ready") return readyResult;
    return { ok: true };
  }
  return { gh, calls, setPr: (n, pr) => prs.set(n, pr), setDiff: (n, f) => diffs.set(n, f) };
}

function makeSpy(impl) {
  function fn(...args) {
    fn.calls.push(args);
    return impl ? impl(...args) : undefined;
  }
  fn.calls = [];
  return fn;
}

function makeStatefulReviewedStore() {
  const seen = new Set();
  const recordReviewed = makeSpy((prNumber, sha) => seen.add(`${prNumber}:${sha}`));
  const alreadyReviewed = makeSpy((prNumber, sha) => seen.has(`${prNumber}:${sha}`));
  return { recordReviewed, alreadyReviewed };
}

/** @description A mergeAndFinalize fake that actually calls gh pr merge (so call-order is observable). */
function makeMergeFake(merged = true) {
  return makeSpy((pr, sha, o) => {
    o.gh(["pr", "merge", String(pr.number), "--squash", "--match-head-commit", sha]);
    return { merged };
  });
}

function baseOpts(overrides = {}) {
  const store = makeStatefulReviewedStore();
  return {
    isReviewEligible,
    getFreshVerdict: () => ({ status: "CLEAN" }),
    crossFamilyEligible: () => true,
    autoMergeEnabled: true,
    mergeAndFinalize: makeMergeFake(true),
    reconcile: makeSpy(() => []),
    routeReject: makeSpy(),
    spawnReviewSession: makeSpy(),
    notify: makeSpy(),
    stateDir: "/fake/state/review",
    authenticatedUser: "bot-user",
    engineKnows: () => true,
    recordReviewSession: makeSpy(),
    breakerTripped: () => false,
    recordReviewed: store.recordReviewed,
    alreadyReviewed: store.alreadyReviewed,
    ...overrides,
  };
}

const idxOf = (calls, pred) => calls.findIndex(pred);
const isReady = (n) => (a) => a[0] === "pr" && a[1] === "ready" && String(a[2]) === String(n);
const isMerge = (a) => a[0] === "pr" && a[1] === "merge";
const addsLabel = (label) => (a) => a[0] === "issue" && a[1] === "edit" && a.includes("--add-label") && a.includes(label);

test("AC-1.1 undraft (gh pr ready) runs BEFORE gh pr merge on the auto-merge path", async () => {
  const { gh, calls, setPr, setDiff } = makeFakeGh();
  setPr(10, { number: 10, headRefName: "harness/42", author: { login: "bot-user" }, labels: [], headSha: "sha-a" });
  setDiff(10, ["src/foo.js"]); // not gate machinery
  await cronReview(baseOpts({ gh }));
  const readyIdx = idxOf(calls, isReady(10));
  const mergeIdx = idxOf(calls, isMerge);
  assert.notEqual(readyIdx, -1, "gh pr ready must be called");
  assert.notEqual(mergeIdx, -1, "gh pr merge must be called (via mergeAndFinalize)");
  assert.ok(readyIdx < mergeIdx, "undraft must precede the merge");
});

test("AC-1.2 undraft runs on the awaiting-merge route (autoMerge off)", async () => {
  const { gh, calls, setPr, setDiff } = makeFakeGh();
  setPr(20, { number: 20, headRefName: "harness/55", author: { login: "bot-user" }, labels: [], headSha: "sha-b" });
  setDiff(20, ["src/bar.js"]);
  await cronReview(baseOpts({ gh, autoMergeEnabled: false }));
  assert.notEqual(idxOf(calls, isReady(20)), -1, "awaiting-merge route must undraft the PR");
});

test("AC-1.2 a non-CLEAN reject route NEVER undrafts (PR stays draft)", async () => {
  const { gh, calls, setPr, setDiff } = makeFakeGh();
  setPr(22, { number: 22, headRefName: "harness/57", author: { login: "bot-user" }, labels: [], headSha: "sha-d" });
  setDiff(22, ["src/baz.js"]);
  await cronReview(baseOpts({ gh, getFreshVerdict: () => ({ status: "BLOCKED" }) }));
  assert.equal(idxOf(calls, isReady(22)), -1, "a non-approved (reject) PR must NOT be undrafted");
});

test("AC-1.3 a failed gh pr ready does not abort the merge", async () => {
  const { gh, setPr, setDiff } = makeFakeGh({ readyResult: { ok: false } });
  setPr(23, { number: 23, headRefName: "harness/58", author: { login: "bot-user" }, labels: [], headSha: "sha-e" });
  setDiff(23, ["src/qux.js"]);
  const mergeSpy = makeMergeFake(true);
  await cronReview(baseOpts({ gh, mergeAndFinalize: mergeSpy }));
  assert.equal(mergeSpy.calls.length, 1, "a failed undraft must not abort the merge");
});

test("AC-1.4 mergeAndFinalize merged:false -> awaiting-merge + recordReviewed once + pr-merge-failed", async () => {
  const { gh, calls, setPr, setDiff } = makeFakeGh();
  setPr(24, { number: 24, headRefName: "harness/59", author: { login: "bot-user" }, labels: [], headSha: "sha-f" });
  setDiff(24, ["src/a.js"]);
  const store = makeStatefulReviewedStore();
  const notify = makeSpy();
  await cronReview(
    baseOpts({
      gh,
      mergeAndFinalize: makeMergeFake(false),
      recordReviewed: store.recordReviewed,
      alreadyReviewed: store.alreadyReviewed,
      notify,
    })
  );
  assert.notEqual(idxOf(calls, addsLabel("harness:awaiting-merge")), -1, "merge-failure must route to awaiting-merge");
  const recorded = store.recordReviewed.calls.filter((c) => String(c[0]) === "24" && c[1] === "sha-f");
  assert.equal(recorded.length, 1, "merge-failure route must recordReviewed exactly once (terminal)");
  assert.ok(notify.calls.some((c) => c[0] && c[0].type === "pr-merge-failed"), "must notify pr-merge-failed");
});

test("AC-2.1 a CLEAN harness-engine PR is treated like any other PR and auto-merges (no carve-out)", async () => {
  const { gh, calls, setPr, setDiff } = makeFakeGh();
  setPr(25, { number: 25, headRefName: "harness/62", author: { login: "bot-user" }, labels: [], headSha: "sha-g" });
  setDiff(25, ["core/vps/x.mjs"]); // formerly gate-machinery — now no special treatment
  const mergeSpy = makeMergeFake(true);
  await cronReview(baseOpts({ gh, mergeAndFinalize: mergeSpy }));
  assert.equal(mergeSpy.calls.length, 1, "an engine-diff PR must auto-merge like any other CLEAN eligible PR");
  assert.equal(idxOf(calls, addsLabel("harness:awaiting-merge")), -1, "an auto-merged engine PR must NOT route to awaiting-merge");
});

test("AC-2.2 a CLEAN non-gate-machinery PR still auto-merges (common path not regressed)", async () => {
  const { gh, setPr, setDiff } = makeFakeGh();
  setPr(27, { number: 27, headRefName: "harness/64", author: { login: "bot-user" }, labels: [], headSha: "sha-i" });
  setDiff(27, ["src/foo.ts"]);
  const mergeSpy = makeMergeFake(true);
  await cronReview(baseOpts({ gh, mergeAndFinalize: mergeSpy }));
  assert.equal(mergeSpy.calls.length, 1, "non-gate-machinery eligible PR must auto-merge");
});

test("AC-2.1 fail-closed: an empty/unknown changed-file set is NEVER auto-merged (routes to manual merge)", async () => {
  const { gh, calls, setPr, setDiff } = makeFakeGh();
  setPr(29, { number: 29, headRefName: "harness/65", author: { login: "bot-user" }, labels: [], headSha: "sha-k" });
  setDiff(29, []); // empty diff — must fail-closed, never slip onto the auto-merge path
  const mergeSpy = makeMergeFake(true);
  await cronReview(baseOpts({ gh, mergeAndFinalize: mergeSpy }));
  assert.equal(mergeSpy.calls.length, 0, "an empty-diff PR must never be auto-merged (fail-closed)");
  assert.notEqual(idxOf(calls, addsLabel("harness:awaiting-merge")), -1, "empty-diff PR routes to manual merge");
});

test("AC-3.2 awaiting-merge relabel strips exactly STATE_LABELS, adds awaiting-merge, preserves domain labels", async () => {
  const { gh, calls, setPr, setDiff } = makeFakeGh();
  setPr(28, { number: 28, headRefName: "harness/86", author: { login: "bot-user" }, labels: ["harness:ready", "tier-1", "kaizen"], headSha: "sha-j" });
  setDiff(28, ["src/z.js"]);
  await cronReview(baseOpts({ gh, autoMergeEnabled: false })); // -> awaiting-merge route
  const edit = calls.find((a) => a[0] === "issue" && a[1] === "edit" && a.includes("--add-label") && a.includes("harness:awaiting-merge"));
  assert.ok(edit, "awaiting-merge relabel must happen");
  const removed = [];
  for (let i = 0; i < edit.length; i++) if (edit[i] === "--remove-label") removed.push(edit[i + 1]);
  for (const l of ["harness:ready", "harness:in-progress", "harness:in-review", "harness:queued"]) {
    assert.ok(removed.includes(l), `must strip ${l}`);
  }
  assert.ok(!removed.includes("tier-1") && !removed.includes("kaizen"), "must preserve domain labels");
});
