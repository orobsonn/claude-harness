/**
 * @description Pinned contract tests for cron-review.mjs — the VPS cron harness's independent
 * PR-review LOGIC (per-PR review + the cycle driver). This suite is intentionally RED until
 * cron-review.mjs exists: it pins the exact seam contract the executor must implement.
 *
 * Exported shape under test:
 *   `cronReview(opts)` — lists open PRs via `opts.gh`, keeps only the ones `opts.isReviewEligible`
 *   accepts, drives `reviewPr(pr, opts)` for each (not exported/tested separately — every
 *   assertion here observes it through cronReview's own gh-call log and injected spies), and
 *   drives `opts.reconcile()` (ZERO-ARG — the composition root pre-binds gh/counter/stateDir into
 *   the closure it hands down) exactly once per cycle, independent of the open-PR set.
 *
 * Per-PR review flow (reviewPr) pinned here via observable behavior:
 *   1. `opts.alreadyReviewed(pr.number, pr.headSha, {stateDir})` — idempotency short-circuit.
 *   2. Reads the diff via `gh(["pr","diff", String(pr.number), ...])` (or `gh api`) — NEVER a
 *      `git checkout`/`switch`/`worktree add` onto `harness/<N>`.
 *   3. `opts.breakerTripped({stateDir})` gate before spawning; `opts.spawnReviewSession(pr, meta)`
 *      then `opts.recordReviewSession({stateDir})` once per spawned session.
 *   4. Fresh verdict: `opts.getFreshVerdict(pr, sha, stateDir)` → `freshVerdictClean`.
 *   5. Cross-family: `opts.crossFamilyEligible(pr)` (pre-bound `pr -> boolean` by the composition
 *      root) → `crossFamilyEligible`.
 *   6. Merge-eligible = `freshVerdictClean && crossFamilyEligible` — a flaky CLEAN alone never
 *      merges because cross-family is always required. A harness-engine diff is treated like any
 *      other PR (no control-surface carve-out, no 2nd pass).
 *   7. Routing on `eligible`:
 *        - `true`  → `opts.mergeAndFinalize(pr, sha, {...})` (autoMerge on + non-empty diff).
 *        - `false` && `!freshVerdictClean` → `opts.routeReject(pr, sha, {...})`.
 *        - `false` (residual: cross-family absent) → `gh(["label","create",
 *          "harness:awaiting-merge","--force"])` THEN `gh(["issue","edit", <root>, ...,
 *          "--add-label","harness:awaiting-merge"])`, AND `opts.recordReviewed(pr.number, sha,
 *          {stateDir})` — same idempotency guarantee while the PR sits awaiting merge.
 *
 * Stalled backstop (at the `alreadyReviewed` branch, BEFORE the silent `continue`): (a) resolve the
 * root issue via `extractRoot(pr.headRefName)` — a non-matching branch name just continues; (b) gate
 * on the cheap marker `opts.stalledNotified(number, sha, {stateDir})` so the (expensive) issue-view
 * lookup and notify only ever run once per pr:sha; (c) read the root issue's labels via
 * `gh(["issue","view", String(root), "--json","labels"])`; (d) if the issue is in the ACTIVE state
 * harness:in-review (and NOT in a terminal-ish state — awaiting-merge / blocked / done — nor an
 * actively-repairing state — harness:ready / harness:in-progress, where a freshly-rejected PR sits
 * at its OLD sha for minutes during normal auto-repair), call `opts.recordStalledNotified(number,
 * sha, {stateDir})` BEFORE emitting exactly one `opts.notify({type:'pr-review-stalled', pr, url})`;
 * (e) this branch NEVER re-reviews — `spawnReviewSession` must never run for an already-reviewed
 * sha, stalled or not.
 *
 * Every seam is injected as an in-memory fake/spy — no real `gh`/`git` process is ever spawned.
 * `isReviewEligible` is the REAL module (not a fake) so a miscomputed origin-gate input is caught
 * by the real gate logic instead of being hidden behind a permissive fake.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { cronReview } from "./cron-review.mjs";
import { isReviewEligible } from "./review-origin-gate.mjs";

/**
 * @description Fake `gh` seam. Records every invocation's argv into `calls` (call order).
 * Answers `gh pr list` with the currently-set PR entries and `gh pr diff <n> ...` with the
 * changed-files array set via `setDiff`. Every other subcommand (`label create`, `issue edit`,
 * `pr merge`, ...) is just recorded and answered with `{ok:true}`.
 */
function makeFakeGh() {
  const calls = [];
  const prs = new Map(); // number -> pr object
  const diffs = new Map(); // number -> changed-files array

  function setPr(number, pr) {
    prs.set(number, pr);
  }
  function setDiff(number, files) {
    diffs.set(number, files);
  }

  function gh(args) {
    calls.push(args);
    if (args[0] === "pr" && args[1] === "list") {
      return [...prs.values()];
    }
    if (args[0] === "pr" && args[1] === "diff") {
      const number = Number(args[2]);
      return diffs.get(number) ?? [];
    }
    return { ok: true };
  }

  return { gh, calls, setPr, setDiff };
}

/** @description Records every call into `.calls` (argv-array-per-call); optionally delegates to `impl`. */
function makeSpy(impl) {
  function fn(...args) {
    fn.calls.push(args);
    return impl ? impl(...args) : undefined;
  }
  fn.calls = [];
  return fn;
}

/**
 * @description Builds a STATEFUL reviewed-PR store backed by a `Set` of `"<pr>:<sha>"` keys, so
 * `recordReviewed`/`alreadyReviewed` behave like the real persisted idempotency ledger across
 * multiple `cronReview` cycles run against the same in-memory store.
 */
function makeStatefulReviewedStore() {
  const seen = new Set();
  const recordReviewed = makeSpy((prNumber, sha, meta) => {
    seen.add(`${prNumber}:${sha}`);
  });
  const alreadyReviewed = makeSpy((prNumber, sha) => seen.has(`${prNumber}:${sha}`));
  return { recordReviewed, alreadyReviewed, seen };
}

/**
 * @description Wraps a fake `gh` so `gh(["issue","view", String(issueNumber), "--json","labels"])`
 * answers with the given label set (in `gh issue view --json labels` shape — `{labels:[{name},...]}`),
 * recorded into the SAME `calls` array as the wrapped `gh`. Every other call delegates unchanged.
 */
function withIssueViewLabels(gh, calls, issueNumber, labelNames) {
  return (args) => {
    if (args[0] === "issue" && args[1] === "view" && args[2] === String(issueNumber)) {
      calls.push(args);
      return { labels: labelNames.map((name) => ({ name })) };
    }
    return gh(args);
  };
}

/** @description Assembles a full cronReview() opts object from defaults + per-test overrides. */
function baseOpts(overrides = {}) {
  return {
    isReviewEligible,
    getFreshVerdict: () => ({ status: "CLEAN" }),
    crossFamilyEligible: () => true,
    autoMergeEnabled: true,
    mergeAndFinalize: makeSpy(),
    reconcile: makeSpy(() => []),
    routeReject: makeSpy(),
    spawnReviewSession: makeSpy(),
    notify: makeSpy(),
    stateDir: "/fake/state/review",
    authenticatedUser: "bot-user",
    engineKnows: () => true,
    recordReviewSession: makeSpy(),
    breakerTripped: () => false,
    alreadyReviewed: () => false,
    recordReviewed: makeSpy(),
    incrementInfraFailure: makeSpy(),
    atInfraFailureCeiling: () => false,
    ...overrides,
  };
}

test("cronReview: reads the PR diff via `gh pr diff <n>` (or `gh api`) and NEVER checks out branch harness/<N>", async () => {
  const { gh, calls, setPr, setDiff } = makeFakeGh();
  setPr(10, { number: 10, headRefName: "harness/42", author: { login: "bot-user" }, labels: [], headSha: "sha-a" });
  setDiff(10, ["src/foo.js"]);

  await cronReview(baseOpts({ gh }));

  const readsDiff = calls.some((args) => (args[0] === "pr" && args[1] === "diff") || args[0] === "api");
  assert.ok(readsDiff, "cronReview must read the PR diff via `gh pr diff <n>` (or `gh api`)");

  const checksOutBranch = calls.some(
    (args) =>
      args.includes("harness/42") &&
      (args.includes("checkout") || args.includes("switch") || (args.includes("worktree") && args.includes("add")))
  );
  assert.ok(
    !checksOutBranch,
    "cronReview must NEVER run a git worktree add / checkout / switch onto harness/<N> to read the diff"
  );
});

test("cronReview: DRIVES reconciliation every cycle — reconcile is invoked independent of the open-PR loop", async () => {
  const { gh } = makeFakeGh(); // no PRs set -> `gh pr list` returns []
  const reconcileSpy = makeSpy(() => []);

  await cronReview(baseOpts({ gh, reconcile: reconcileSpy }));

  assert.ok(
    reconcileSpy.calls.length >= 1,
    "reconcile must be invoked during the cycle even when the open-PR list is empty — the self-heal is DRIVEN, not merely defined"
  );
});

test("cronReview: awaiting-merge label-create happens BEFORE the first relabel to harness:awaiting-merge", async () => {
  const { gh, calls, setPr, setDiff } = makeFakeGh();
  setPr(20, { number: 20, headRefName: "harness/55", author: { login: "bot-user" }, labels: [], headSha: "sha-b" });
  setDiff(20, ["src/bar.js"]); // not gate machinery

  await cronReview(
    baseOpts({
      gh,
      crossFamilyEligible: () => false, // cross-family absent -> routes to harness:awaiting-merge
      mergeAndFinalize: makeSpy(),
    })
  );

  const labelCreateIndex = calls.findIndex(
    (args) =>
      args[0] === "label" && args[1] === "create" && args[2] === "harness:awaiting-merge" && args.includes("--force")
  );
  const relabelIndex = calls.findIndex(
    (args) =>
      args[0] === "issue" && args[1] === "edit" && args.includes("--add-label") && args.includes("harness:awaiting-merge")
  );

  assert.notEqual(labelCreateIndex, -1, "`gh label create harness:awaiting-merge --force` must be invoked");
  assert.notEqual(relabelIndex, -1, "an issue must be relabeled to harness:awaiting-merge");
  assert.ok(
    labelCreateIndex < relabelIndex,
    "the idempotent label-create must run BEFORE the first relabel to harness:awaiting-merge (ordered)"
  );
});

test("cronReview: CONJUNCTION at the merge boundary — mergeAndFinalize is NEVER invoked unless fresh-CLEAN AND cross-family both hold", async () => {
  // fresh verdict CLEAN but crossFamilyEligible=false -> never merges, routes to awaiting-merge.
  const { gh, calls, setPr, setDiff } = makeFakeGh();
  setPr(30, { number: 30, headRefName: "harness/60", author: { login: "bot-user" }, labels: [], headSha: "sha-c" });
  setDiff(30, ["src/baz.js"]); // not gate machinery
  const mergeAndFinalizeSpy = makeSpy();

  await cronReview(
    baseOpts({
      gh,
      crossFamilyEligible: () => false,
      mergeAndFinalize: mergeAndFinalizeSpy,
    })
  );

  assert.equal(
    mergeAndFinalizeSpy.calls.length,
    0,
    "[cross-family absent] mergeAndFinalize must NEVER be invoked on a fresh-CLEAN-alone verdict"
  );
  const routedAwaitingMerge = calls.some(
    (args) =>
      args[0] === "issue" && args[1] === "edit" && args.includes("--add-label") && args.includes("harness:awaiting-merge")
  );
  assert.ok(routedAwaitingMerge, "[cross-family absent] the PR's issue must be routed to harness:awaiting-merge");
});

test("cronReview: awaiting-merge route records pr:sha so a same-SHA re-review is a no-op", async () => {
  const stateDir = "/fake/state/review";
  const { gh, setPr, setDiff } = makeFakeGh();
  const pr = { number: 40, headRefName: "harness/70", author: { login: "bot-user" }, labels: [], headSha: "sha-e" };
  setPr(pr.number, pr);
  setDiff(pr.number, ["src/qux.js"]); // not gate machinery

  const { recordReviewed, alreadyReviewed } = makeStatefulReviewedStore();
  const spawnReviewSession = makeSpy();

  const opts = baseOpts({
    gh,
    stateDir,
    crossFamilyEligible: () => false, // cross-family absent -> residual awaiting-merge route
    recordReviewed,
    alreadyReviewed,
    spawnReviewSession,
  });

  // Cycle 1: PR is fresh -> reviewed, routed to awaiting-merge, and recorded.
  await cronReview(opts);

  assert.equal(recordReviewed.calls.length, 1, "recordReviewed must be called once after the awaiting-merge route");
  const [recordedPrNumber, recordedSha, recordedMeta] = recordReviewed.calls[0];
  assert.equal(recordedPrNumber, pr.number, "recordReviewed must receive the PR number as the first arg");
  assert.equal(recordedSha, pr.headSha, "recordReviewed must receive the head SHA as the second arg");
  assert.equal(typeof recordedMeta, "object", "recordReviewed's third arg must be an object");
  assert.equal(recordedMeta.stateDir, stateDir, "recordReviewed's third arg must carry the stateDir");
  assert.equal(recordReviewed.calls[0].length, 3, "recordReviewed must be called with exactly 3 args");

  // Cycle 2: SAME PR, SAME headSha -> alreadyReviewed short-circuits, no new session is spawned.
  const { gh: gh2, setPr: setPr2, setDiff: setDiff2 } = makeFakeGh();
  setPr2(pr.number, pr);
  setDiff2(pr.number, ["src/qux.js"]);
  await cronReview({ ...opts, gh: gh2 });

  assert.equal(
    spawnReviewSession.calls.length,
    1,
    "across BOTH cycles spawnReviewSession must be invoked EXACTLY ONCE — cycle 2 short-circuits via alreadyReviewed"
  );
});

test("cronReview: requests headRefOid (not the invalid headSha field) in `gh pr list --json` — regression for the blank-cycle bug", async () => {
  const { gh, calls, setPr, setDiff } = makeFakeGh();
  setPr(50, { number: 50, headRefName: "harness/80", author: { login: "bot-user" }, labels: [], headSha: "sha-h" });
  setDiff(50, ["docs/x.md"]);

  await cronReview(baseOpts({ gh }));

  const listCall = calls.find((a) => a[0] === "pr" && a[1] === "list" && a.includes("--json"));
  assert.ok(listCall, "must call `gh pr list --json`");
  const jsonFields = listCall[listCall.indexOf("--json") + 1];
  assert.match(jsonFields, /headRefOid/, "must request the valid `headRefOid` field");
  assert.doesNotMatch(
    jsonFields,
    /headSha/,
    "must NOT request the invalid `headSha` field — gh exits non-zero → [] → the whole review cycle silently blanks"
  );
});

test("cronReview: notifies review-started (before spawn) and pr-awaiting-merge on the cross-family-absent route", async () => {
  const { gh, setPr, setDiff } = makeFakeGh();
  setPr(51, { number: 51, headRefName: "harness/81", author: { login: "bot-user" }, labels: [], headSha: "sha-i", url: "u51" });
  setDiff(51, ["src/x.js"]);

  const notify = makeSpy();
  await cronReview(baseOpts({ gh, notify, crossFamilyEligible: () => false, mergeAndFinalize: makeSpy() }));

  const types = notify.calls.map((a) => a[0] && a[0].type);
  assert.ok(types.includes("review-started"), "must notify review-started so the operator sees the analysis begin");
  assert.ok(types.includes("pr-awaiting-merge"), "must notify pr-awaiting-merge when cross-family is absent");
});

test("cronReview: AWAITS the review-started send (it SETTLES) before the blocking review-session spawn", async () => {
  const { gh, setPr, setDiff } = makeFakeGh();
  setPr(70, { number: 70, headRefName: "harness/100", author: { login: "bot-user" }, labels: [], headSha: "sha-p", url: "u70" });
  setDiff(70, ["src/x.js"]);

  const order = [];
  // review-started's send resolves on a LATER microtask. If cronReview does NOT await it, the
  // synchronous spawnReviewSession runs first and "spawn" precedes "review-started:settled" —
  // exactly the bug (the 5s AbortSignal expires during the multi-minute spawn, dropping the ping).
  const notify = (event) => {
    if (event && event.type === "review-started") {
      return Promise.resolve().then(() => order.push("review-started:settled"));
    }
    return undefined;
  };
  const spawnReviewSession = makeSpy(() => order.push("spawn"));

  await cronReview(
    baseOpts({ gh, notify, spawnReviewSession, crossFamilyEligible: () => false, mergeAndFinalize: makeSpy() })
  );

  const settledIdx = order.indexOf("review-started:settled");
  const spawnIdx = order.indexOf("spawn");
  assert.notEqual(settledIdx, -1, "the review-started send must settle");
  assert.notEqual(spawnIdx, -1, "the review session must be spawned");
  assert.ok(
    settledIdx < spawnIdx,
    "review-started must be AWAITED — its send has to SETTLE before the blocking spawn, never after"
  );
});

test("cronReview: notifies pr-merged when mergeAndFinalize reports a merge", async () => {
  const { gh, setPr, setDiff } = makeFakeGh();
  setPr(52, { number: 52, headRefName: "harness/82", author: { login: "bot-user" }, labels: [], headSha: "sha-j", url: "u52" });
  setDiff(52, ["src/y.js"]);

  const notify = makeSpy();
  await cronReview(baseOpts({ gh, notify, mergeAndFinalize: makeSpy(() => ({ merged: true })) }));

  const types = notify.calls.map((a) => a[0] && a[0].type);
  assert.ok(types.includes("pr-merged"), "must notify pr-merged on a successful autonomous merge");
});

test("cronReview: AWAITS the pr-merged send (it SETTLES) before reconcile() runs (mirrors the already-awaited review-started)", async () => {
  const { gh, setPr, setDiff } = makeFakeGh();
  setPr(110, { number: 110, headRefName: "harness/210", author: { login: "bot-user" }, labels: [], headSha: "sha-z", url: "u110" });
  setDiff(110, ["src/merged.js"]);

  const order = [];
  // pr-merged's send resolves on a LATER microtask. If cronReview does NOT await it, the
  // post-loop reconcile() call runs first and "reconcile" precedes "pr-merged:settled" — the same
  // dropped-ping shape as the already-fixed review-started bug, just on the merged branch instead.
  const notify = (event) => {
    if (event && event.type === "pr-merged") {
      return Promise.resolve().then(() => order.push("pr-merged:settled"));
    }
    return undefined;
  };
  const reconcile = makeSpy(() => {
    order.push("reconcile");
    return [];
  });

  await cronReview(
    baseOpts({
      gh,
      notify,
      reconcile,
      autoMergeEnabled: true,
      crossFamilyEligible: () => true,
      mergeAndFinalize: makeSpy(() => ({ merged: true })),
    })
  );

  const settledIdx = order.indexOf("pr-merged:settled");
  const reconcileIdx = order.indexOf("reconcile");
  assert.notEqual(settledIdx, -1, "the pr-merged send must settle");
  assert.notEqual(reconcileIdx, -1, "reconcile must run during the cycle");
  assert.ok(
    settledIdx < reconcileIdx,
    "pr-merged must be AWAITED — its send has to SETTLE before reconcile() runs, never after"
  );
});

test("cronReview: a diff-fetch failure sentinel {ok:false,diffFailed:true} re-queues (notify pr-diff-fetch-failed, NO spawn, NO recordReviewed)", async () => {
  const { gh, setPr, setDiff } = makeFakeGh();
  setPr(60, { number: 60, headRefName: "harness/90", author: { login: "bot-user" }, labels: [], headSha: "sha-k" });
  setDiff(60, { ok: false, diffFailed: true }); // fetch failure sentinel
  const notify = makeSpy();
  const spawnReviewSession = makeSpy();
  const recordReviewed = makeSpy();
  await cronReview(baseOpts({ gh, notify, spawnReviewSession, recordReviewed }));
  const types = notify.calls.map((a) => a[0] && a[0].type);
  assert.ok(types.includes("pr-diff-fetch-failed"), "must notify pr-diff-fetch-failed on a diff sentinel");
  assert.equal(spawnReviewSession.calls.length, 0, "must NOT spawn a review session on a diff fetch failure");
  assert.equal(recordReviewed.calls.length, 0, "must NOT record reviewed (re-queue: retry next cycle)");
});

test("cronReview: a genuinely empty diff [] is NOT a fetch failure — the review session IS spawned", async () => {
  const { gh, setPr, setDiff } = makeFakeGh();
  setPr(61, { number: 61, headRefName: "harness/91", author: { login: "bot-user" }, labels: [], headSha: "sha-l" });
  setDiff(61, []); // genuinely empty
  const spawnReviewSession = makeSpy();
  await cronReview(baseOpts({ gh, spawnReviewSession }));
  assert.equal(spawnReviewSession.calls.length, 1, "an empty [] diff must proceed to a normal review spawn");
});

test("cronReview: fully-eligible PR with autoMergeEnabled false routes to awaiting-merge (mergeAndFinalize never called, recordReviewed once)", async () => {
  const { gh, calls, setPr, setDiff } = makeFakeGh();
  setPr(62, { number: 62, headRefName: "harness/92", author: { login: "bot-user" }, labels: [], headSha: "sha-m" });
  setDiff(62, ["src/ok.js"]); // not gate machinery
  const mergeAndFinalize = makeSpy(() => ({ merged: true }));
  const recordReviewed = makeSpy();
  await cronReview(baseOpts({ gh, autoMergeEnabled: false, crossFamilyEligible: () => true, mergeAndFinalize, recordReviewed }));
  assert.equal(mergeAndFinalize.calls.length, 0, "autoMergeEnabled false must NOT auto-merge an eligible PR");
  const routedAwaiting = calls.some((a) => a[0] === "issue" && a[1] === "edit" && a.includes("--add-label") && a.includes("harness:awaiting-merge"));
  assert.ok(routedAwaiting, "flag-off eligible PR must be routed to harness:awaiting-merge");
  assert.equal(recordReviewed.calls.length, 1, "the awaiting-merge route records reviewed exactly once");
});

test("cronReview: fully-eligible PR with autoMergeEnabled true DOES call mergeAndFinalize(pr, sha, opts)", async () => {
  const { gh, setPr, setDiff } = makeFakeGh();
  const pr = { number: 63, headRefName: "harness/93", author: { login: "bot-user" }, labels: [], headSha: "sha-n" };
  setPr(63, pr);
  setDiff(63, ["src/ok2.js"]);
  const mergeAndFinalize = makeSpy(() => ({ merged: true }));
  await cronReview(baseOpts({ gh, autoMergeEnabled: true, crossFamilyEligible: () => true, mergeAndFinalize }));
  assert.equal(mergeAndFinalize.calls.length, 1, "autoMergeEnabled true must auto-merge an eligible PR");
  assert.equal(mergeAndFinalize.calls[0][0].number, 63, "mergeAndFinalize receives the pr as first arg");
  assert.equal(mergeAndFinalize.calls[0][1], "sha-n", "mergeAndFinalize receives the head sha as second arg");
});

test("cronReview: crossFamilyEligible is called with (pr, {changedFiles, sha, stateDir}) and its boolean return is consumed synchronously", async () => {
  const { gh, calls, setPr, setDiff } = makeFakeGh();
  setPr(64, { number: 64, headRefName: "harness/94", author: { login: "bot-user" }, labels: [], headSha: "sha-o" });
  setDiff(64, ["src/ok3.js"]);
  const cfeSpy = makeSpy(() => false); // returns a plain boolean; false → awaiting-merge route
  await cronReview(baseOpts({ gh, crossFamilyEligible: cfeSpy, mergeAndFinalize: makeSpy() }));
  assert.equal(cfeSpy.calls.length, 1, "crossFamilyEligible must be called once for the PR");
  const secondArg = cfeSpy.calls[0][1];
  assert.equal(typeof secondArg, "object", "crossFamilyEligible's 2nd arg must be an options object");
  assert.deepEqual(secondArg.changedFiles, ["src/ok3.js"], "2nd arg must carry the changedFiles");
  assert.equal(secondArg.sha, "sha-o", "2nd arg must carry the head sha");
  assert.equal(typeof secondArg.stateDir, "string", "2nd arg must carry the stateDir");
  // a plain boolean false was consumed synchronously → routed to awaiting-merge (a Promise would be truthy and merge/misroute)
  const routedAwaiting = calls.some((a) => a[0] === "issue" && a[1] === "edit" && a.includes("--add-label") && a.includes("harness:awaiting-merge"));
  assert.ok(routedAwaiting, "a synchronous boolean false must route to awaiting-merge (proves no await/Promise truthiness)");
});

test("cronReview: a terminal rejected auto-merge (mergeAndFinalize returns {merged:false, terminal:true}) notifies pr-merge-failed and routes to awaiting-merge", async () => {
  const { gh, calls, setPr, setDiff } = makeFakeGh();
  setPr(80, { number: 80, headRefName: "harness/120", author: { login: "bot-user" }, labels: [], headSha: "sha-mf", url: "u80" });
  setDiff(80, ["src/z.js"]); // not gate machinery
  const notify = makeSpy();
  const recordReviewed = makeSpy();
  await cronReview(baseOpts({ gh, notify, recordReviewed, autoMergeEnabled: true, crossFamilyEligible: () => true, mergeAndFinalize: makeSpy(() => ({ merged: false, terminal: true })) }));
  const types = notify.calls.map((a) => a[0] && a[0].type);
  assert.ok(types.includes("pr-merge-failed"), "a terminal rejected auto-merge must notify pr-merge-failed");
  assert.ok(!types.includes("pr-merged"), "a rejected merge must NOT notify pr-merged");
  const routedAwaiting = calls.some((a) => a[0] === "issue" && a[1] === "edit" && a.includes("--add-label") && a.includes("harness:awaiting-merge"));
  assert.ok(routedAwaiting, "a terminal merge failure routes the issue to harness:awaiting-merge");
});

test("cronReview: a BEHIND-branch auto-merge (mergeAndFinalize returns {updateAttempted:true, terminal:false}) notifies pr-branch-updated-retry, does NOT relabel to awaiting-merge, does NOT recordReviewed (re-reviews next cycle at the new sha)", async () => {
  const { gh, calls, setPr, setDiff } = makeFakeGh();
  setPr(81, { number: 81, headRefName: "harness/121", author: { login: "bot-user" }, labels: [], headSha: "sha-behind", url: "u81" });
  setDiff(81, ["src/z.js"]); // not gate machinery
  const notify = makeSpy();
  const recordReviewed = makeSpy();
  await cronReview(baseOpts({ gh, notify, recordReviewed, autoMergeEnabled: true, crossFamilyEligible: () => true, mergeAndFinalize: makeSpy(() => ({ merged: false, updateAttempted: true, terminal: false })) }));
  const types = notify.calls.map((a) => a[0] && a[0].type);
  assert.ok(types.includes("pr-branch-updated-retry"), "a BEHIND-branch update must notify pr-branch-updated-retry (progress, not failure)");
  assert.ok(!types.includes("pr-merge-failed"), "a self-healing update-branch is NOT a merge failure — must not notify pr-merge-failed");
  assert.ok(!types.includes("pr-merged"), "the PR did not merge this pass — must not notify pr-merged");
  const routedAwaiting = calls.some((a) => a[0] === "issue" && a[1] === "edit" && a.includes("--add-label") && a.includes("harness:awaiting-merge"));
  assert.ok(!routedAwaiting, "an update-branch retry must NOT relabel the issue to awaiting-merge — the review loop re-picks it up");
  assert.equal(recordReviewed.calls.length, 0, "an update-branch retry must NOT record the (pr, sha) as reviewed — the sha changes and must re-review");
});

test("cronReview: verdict === null below the ceiling → counts infra-failure, retries next cycle (NO routeReject, NO relabel, NO recordReviewed)", async () => {
  const { gh, calls, setPr, setDiff } = makeFakeGh();
  setPr(90, { number: 90, headRefName: "harness/130", author: { login: "bot-user" }, labels: [], headSha: "sha-crash", url: "u90" });
  setDiff(90, ["src/a.js"]);
  const routeReject = makeSpy();
  const recordReviewed = makeSpy();
  const mergeAndFinalize = makeSpy();
  const incrementInfraFailure = makeSpy();
  const notify = makeSpy();

  await cronReview(
    baseOpts({
      gh,
      getFreshVerdict: () => null, // the review session crashed — no verdict artifact
      atInfraFailureCeiling: () => false, // still below the ceiling
      incrementInfraFailure,
      routeReject,
      recordReviewed,
      mergeAndFinalize,
      notify,
    })
  );

  assert.equal(incrementInfraFailure.calls.length, 1, "a null verdict must count one infra-failure for this pr:sha");
  assert.deepEqual(
    [incrementInfraFailure.calls[0][0], incrementInfraFailure.calls[0][1]],
    [90, "sha-crash"],
    "incrementInfraFailure must receive (pr number, head sha)"
  );
  assert.equal(routeReject.calls.length, 0, "a crash (null verdict) must NEVER routeReject — that would re-dispatch the whole issue");
  assert.equal(recordReviewed.calls.length, 0, "below the ceiling the PR is NOT recorded reviewed — the next cycle retries the review");
  assert.equal(mergeAndFinalize.calls.length, 0, "a null verdict must never merge");
  const relabeled = calls.some((a) => a[0] === "issue" && a[1] === "edit" && a.includes("--add-label"));
  assert.ok(!relabeled, "below the ceiling nothing is relabeled (not ready, not blocked, not awaiting-merge)");
  const types = notify.calls.map((a) => a[0] && a[0].type);
  assert.ok(!types.includes("pr-review-infra-blocked"), "below the ceiling must NOT notify pr-review-infra-blocked");
});

test("cronReview: verdict === null AT the ceiling → blocks the root issue, records reviewed, notifies pr-review-infra-blocked (NO routeReject)", async () => {
  const { gh, calls, setPr, setDiff } = makeFakeGh();
  setPr(91, { number: 91, headRefName: "harness/131", author: { login: "bot-user" }, labels: [], headSha: "sha-dead", url: "u91" });
  setDiff(91, ["src/b.js"]);
  const routeReject = makeSpy();
  const recordReviewed = makeSpy();
  const notify = makeSpy();

  await cronReview(
    baseOpts({
      gh,
      getFreshVerdict: () => null,
      atInfraFailureCeiling: () => true, // the 3rd failure — ceiling reached
      routeReject,
      recordReviewed,
      notify,
    })
  );

  assert.equal(routeReject.calls.length, 0, "reaching the infra-failure ceiling must NEVER routeReject");
  const blocked = calls.some((a) => a[0] === "issue" && a[1] === "edit" && a.includes("--add-label") && a.includes("harness:blocked"));
  assert.ok(blocked, "at the ceiling the root issue must be relabeled harness:blocked");
  assert.equal(recordReviewed.calls.length, 1, "at the ceiling the (pr, sha) must be recorded reviewed to stop re-reviewing the dead sha");
  const [recordedPr, recordedSha] = recordReviewed.calls[0];
  assert.equal(recordedPr, 91, "recordReviewed receives the PR number");
  assert.equal(recordedSha, "sha-dead", "recordReviewed receives the head sha");
  const types = notify.calls.map((a) => a[0] && a[0].type);
  assert.ok(types.includes("pr-review-infra-blocked"), "at the ceiling must notify pr-review-infra-blocked");
});

test("cronReview: verdict {status:'BLOCKED'} (non-null) STILL calls routeReject — a real rejection is not an infra crash (regression guard)", async () => {
  const { gh, setPr, setDiff } = makeFakeGh();
  setPr(92, { number: 92, headRefName: "harness/132", author: { login: "bot-user" }, labels: [], headSha: "sha-block", url: "u92" });
  setDiff(92, ["src/c.js"]);
  const routeReject = makeSpy();
  const incrementInfraFailure = makeSpy();

  await cronReview(
    baseOpts({
      gh,
      getFreshVerdict: () => ({ status: "BLOCKED", finding: "real bug" }),
      routeReject,
      incrementInfraFailure,
    })
  );

  assert.equal(routeReject.calls.length, 1, "a real BLOCKED verdict must still routeReject (rejection behavior preserved)");
  assert.equal(routeReject.calls[0][0].number, 92, "routeReject receives the pr");
  assert.equal(routeReject.calls[0][1], "sha-block", "routeReject receives the head sha");
  assert.equal(incrementInfraFailure.calls.length, 0, "a non-null verdict must NOT count as an infra-failure");
});

test("cronReview: an already-reviewed PR is NEVER re-reviewed — spawnReviewSession never runs even with an active-labeled root issue (kills the BLOCKED->CLEAN same-sha flip)", async () => {
  const { gh, calls, setPr, setDiff } = makeFakeGh();
  const pr = { number: 100, headRefName: "harness/200", author: { login: "bot-user" }, labels: [], headSha: "sha-q", url: "u100" };
  setPr(pr.number, pr);
  setDiff(pr.number, ["src/x.js"]);
  const spawnReviewSession = makeSpy();
  const ghWithLabels = withIssueViewLabels(gh, calls, 200, ["harness:awaiting-merge"]);

  await cronReview(
    baseOpts({
      gh: ghWithLabels,
      alreadyReviewed: () => true,
      spawnReviewSession,
    })
  );

  assert.equal(spawnReviewSession.calls.length, 0, "an already-reviewed PR at the same sha must never be re-reviewed");
});

test("cronReview: a fresh CLEAN verdict with autoMergeEnabled false still records reviewed via the awaiting-merge route (regression preserved)", async () => {
  const { gh, setPr, setDiff } = makeFakeGh();
  const pr = { number: 101, headRefName: "harness/201", author: { login: "bot-user" }, labels: [], headSha: "sha-r" };
  setPr(pr.number, pr);
  setDiff(pr.number, ["src/y.js"]);
  const recordReviewed = makeSpy();

  await cronReview(
    baseOpts({
      gh,
      getFreshVerdict: () => ({ status: "CLEAN" }),
      crossFamilyEligible: () => true,
      autoMergeEnabled: false,
      recordReviewed,
    })
  );

  assert.equal(recordReviewed.calls.length, 1, "recordReviewed must be called once on the awaiting-merge route");
  assert.equal(recordReviewed.calls[0][0], pr.number, "recordReviewed receives the pr number");
  assert.equal(recordReviewed.calls[0][1], pr.headSha, "recordReviewed receives the head sha");
});

test("cronReview: a crashed review (null verdict) below the infra-failure ceiling does NOT record reviewed (regression preserved)", async () => {
  const { gh, setPr, setDiff } = makeFakeGh();
  const pr = { number: 102, headRefName: "harness/202", author: { login: "bot-user" }, labels: [], headSha: "sha-s" };
  setPr(pr.number, pr);
  setDiff(pr.number, ["src/z.js"]);
  const recordReviewed = makeSpy();

  await cronReview(
    baseOpts({
      gh,
      getFreshVerdict: () => null,
      atInfraFailureCeiling: () => false,
      alreadyReviewed: () => false,
      recordReviewed,
    })
  );

  assert.equal(recordReviewed.calls.length, 0, "a crashed review below the ceiling must not be recorded reviewed for that pr:sha");
});

test("cronReview: the stalled backstop notifies pr-review-stalled exactly once for an active in-review issue and records the stalled marker (spawnReviewSession never runs)", async () => {
  const { gh, calls, setPr, setDiff } = makeFakeGh();
  const pr = { number: 103, headRefName: "harness/203", author: { login: "bot-user" }, labels: [], headSha: "sha-t", url: "u103" };
  setPr(pr.number, pr);
  setDiff(pr.number, ["src/w.js"]);
  const ghWithLabels = withIssueViewLabels(gh, calls, 203, ["harness:in-review"]);
  const notify = makeSpy();
  const recordStalledNotified = makeSpy();
  const spawnReviewSession = makeSpy();

  await cronReview(
    baseOpts({
      gh: ghWithLabels,
      alreadyReviewed: () => true,
      stalledNotified: () => false,
      notify,
      recordStalledNotified,
      spawnReviewSession,
    })
  );

  const stalledNotifies = notify.calls.filter((a) => a[0] && a[0].type === "pr-review-stalled" && a[0].pr === pr.number);
  assert.equal(stalledNotifies.length, 1, "exactly one pr-review-stalled notify must be emitted for this pr");
  assert.equal(recordStalledNotified.calls.length, 1, "recordStalledNotified must be called once");
  assert.equal(recordStalledNotified.calls[0][0], pr.number, "recordStalledNotified receives the pr number");
  assert.equal(recordStalledNotified.calls[0][1], pr.headSha, "recordStalledNotified receives the head sha");
  assert.equal(spawnReviewSession.calls.length, 0, "spawnReviewSession must never run for an alreadyReviewed sha");
});

test("cronReview: the stalled backstop is rate-limited to one notify per pr:sha — stalledNotified=true skips both the notify and the issue-view lookup", async () => {
  const { gh, calls, setPr, setDiff } = makeFakeGh();
  const pr = { number: 104, headRefName: "harness/204", author: { login: "bot-user" }, labels: [], headSha: "sha-u", url: "u104" };
  setPr(pr.number, pr);
  setDiff(pr.number, ["src/v.js"]);
  const notify = makeSpy();

  await cronReview(
    baseOpts({
      gh,
      alreadyReviewed: () => true,
      stalledNotified: () => true,
      notify,
    })
  );

  const stalledNotifies = notify.calls.filter((a) => a[0] && a[0].type === "pr-review-stalled");
  assert.equal(stalledNotifies.length, 0, "no pr-review-stalled notify must be emitted once the pr:sha is already marked stalled-notified");
  const issueViewCalled = calls.some((a) => a[0] === "issue" && a[1] === "view");
  assert.ok(!issueViewCalled, "gh issue view need not even be called once the cheap stalledNotified marker gates the check");
});

test("cronReview: the stalled backstop excludes an awaiting-merge issue — no pr-review-stalled notify", async () => {
  const { gh, calls, setPr, setDiff } = makeFakeGh();
  const pr = { number: 105, headRefName: "harness/205", author: { login: "bot-user" }, labels: [], headSha: "sha-v", url: "u105" };
  setPr(pr.number, pr);
  setDiff(pr.number, ["src/u.js"]);
  const ghWithLabels = withIssueViewLabels(gh, calls, 205, ["harness:awaiting-merge"]);
  const notify = makeSpy();

  await cronReview(
    baseOpts({
      gh: ghWithLabels,
      alreadyReviewed: () => true,
      stalledNotified: () => false,
      notify,
    })
  );

  const stalledNotifies = notify.calls.filter((a) => a[0] && a[0].type === "pr-review-stalled");
  assert.equal(stalledNotifies.length, 0, "an awaiting-merge issue must never emit a pr-review-stalled notify");
});

test("cronReview: the stalled backstop excludes a done issue — no notify and recordStalledNotified never called (same allowlist as awaiting-merge/blocked)", async () => {
  const { gh, calls, setPr, setDiff } = makeFakeGh();
  const pr = { number: 106, headRefName: "harness/206", author: { login: "bot-user" }, labels: [], headSha: "sha-w", url: "u106" };
  setPr(pr.number, pr);
  setDiff(pr.number, ["src/t.js"]);
  const ghWithLabels = withIssueViewLabels(gh, calls, 206, ["harness:done"]);
  const notify = makeSpy();
  const recordStalledNotified = makeSpy();

  await cronReview(
    baseOpts({
      gh: ghWithLabels,
      alreadyReviewed: () => true,
      stalledNotified: () => false,
      notify,
      recordStalledNotified,
    })
  );

  const stalledNotifies = notify.calls.filter((a) => a[0] && a[0].type === "pr-review-stalled");
  assert.equal(stalledNotifies.length, 0, "a done issue must never emit a pr-review-stalled notify");
  assert.equal(recordStalledNotified.calls.length, 0, "recordStalledNotified must never be called for a done issue");
});

test("cronReview: the stalled backstop excludes a harness:ready root issue — a freshly re-queued PR being repaired is not stalled (no notify, no re-review)", async () => {
  const { gh, calls, setPr, setDiff } = makeFakeGh();
  const pr = { number: 107, headRefName: "harness/207", author: { login: "bot-user" }, labels: [], headSha: "sha-x", url: "u107" };
  setPr(pr.number, pr);
  setDiff(pr.number, ["src/s.js"]);
  const ghWithLabels = withIssueViewLabels(gh, calls, 207, ["harness:ready"]);
  const notify = makeSpy();
  const recordStalledNotified = makeSpy();
  const spawnReviewSession = makeSpy();

  await cronReview(
    baseOpts({
      gh: ghWithLabels,
      alreadyReviewed: () => true,
      stalledNotified: () => false,
      notify,
      recordStalledNotified,
      spawnReviewSession,
    })
  );

  const stalledNotifies = notify.calls.filter((a) => a[0] && a[0].type === "pr-review-stalled");
  assert.equal(stalledNotifies.length, 0, "a freshly re-queued PR is being repaired, not stalled — no pr-review-stalled notify");
  assert.equal(recordStalledNotified.calls.length, 0, "recordStalledNotified must never be called for a ready issue");
  assert.equal(spawnReviewSession.calls.length, 0, "spawnReviewSession must never run for an alreadyReviewed sha");
});

test("cronReview: the stalled backstop excludes a harness:in-progress root issue — a PR whose repair is in progress is not stalled (no notify, no re-review)", async () => {
  const { gh, calls, setPr, setDiff } = makeFakeGh();
  const pr = { number: 108, headRefName: "harness/208", author: { login: "bot-user" }, labels: [], headSha: "sha-y", url: "u108" };
  setPr(pr.number, pr);
  setDiff(pr.number, ["src/r.js"]);
  const ghWithLabels = withIssueViewLabels(gh, calls, 208, ["harness:in-progress"]);
  const notify = makeSpy();
  const recordStalledNotified = makeSpy();
  const spawnReviewSession = makeSpy();

  await cronReview(
    baseOpts({
      gh: ghWithLabels,
      alreadyReviewed: () => true,
      stalledNotified: () => false,
      notify,
      recordStalledNotified,
      spawnReviewSession,
    })
  );

  const stalledNotifies = notify.calls.filter((a) => a[0] && a[0].type === "pr-review-stalled");
  assert.equal(stalledNotifies.length, 0, "a PR whose repair is in progress is not stalled — no pr-review-stalled notify");
  assert.equal(recordStalledNotified.calls.length, 0, "recordStalledNotified must never be called for an in-progress issue");
  assert.equal(spawnReviewSession.calls.length, 0, "spawnReviewSession must never run for an alreadyReviewed sha");
});

test("cronReview: a feat/x-branch PR's emitted lifecycle event carries root===42 resolved via the prLinksIssue body-link fallback (#ac-1.3) — extractRoot alone yields null for a non-harness/<N> branch", async () => {
  const { gh, setPr, setDiff } = makeFakeGh();
  setPr(200, {
    number: 200,
    headRefName: "feat/x",
    author: { login: "bot-user" },
    labels: [{ name: "harness:autoreview" }],
    headSha: "sha-root",
    url: "u200",
    body: "Some description. Closes #42",
  });
  setDiff(200, ["src/feat.js"]);

  const notify = makeSpy();
  await cronReview(baseOpts({ gh, notify }));

  const reviewStarted = notify.calls.find((a) => a[0] && a[0].type === "review-started");
  assert.ok(reviewStarted, "review-started must be emitted for the eligible feat/x PR (harness:autoreview + engineKnows)");
  assert.equal(
    reviewStarted[0].root,
    42,
    "the emitted event must carry root===42 — resolved via the prLinksIssue('Closes #42') body-link fallback, since headRefName 'feat/x' is not harness/<N> and extractRoot alone would yield null"
  );
});

test("cronReview: spawns AT MOST ONE review session per invocation even with multiple eligible PRs (per-cycle cap so the grace-bounded review lock is never reclaimed mid-cycle into a concurrent second review)", async () => {
  const { gh, setPr, setDiff } = makeFakeGh();
  setPr(10, { number: 10, headRefName: "harness/42", author: { login: "bot-user" }, labels: [], headSha: "sha-a" });
  setPr(11, { number: 11, headRefName: "harness/43", author: { login: "bot-user" }, labels: [], headSha: "sha-b" });
  setDiff(10, ["src/a.ts"]);
  setDiff(11, ["src/b.ts"]);

  const spawnReviewSession = makeSpy();
  await cronReview(baseOpts({ gh, spawnReviewSession, mergeAndFinalize: makeSpy(() => ({ merged: true })) }));

  assert.equal(
    spawnReviewSession.calls.length,
    1,
    "a single cronReview invocation must spawn EXACTLY ONE review session; the other eligible PR is left for the next tick so the review lock never overruns its grace"
  );
});

test("cronReview: an already-reviewed PR does NOT consume the per-cycle review budget — the next fresh PR is still reviewed", async () => {
  const { gh, setPr, setDiff } = makeFakeGh();
  setPr(10, { number: 10, headRefName: "harness/42", author: { login: "bot-user" }, labels: [], headSha: "sha-a" });
  setPr(11, { number: 11, headRefName: "harness/43", author: { login: "bot-user" }, labels: [], headSha: "sha-b" });
  setDiff(10, ["src/a.ts"]);
  setDiff(11, ["src/b.ts"]);

  const spawnReviewSession = makeSpy();
  // #10 is already reviewed at its current sha -> skipped early (no spawn); #11 is fresh.
  const alreadyReviewed = (prNumber, sha) => prNumber === 10 && sha === "sha-a";
  await cronReview(baseOpts({ gh, spawnReviewSession, alreadyReviewed, mergeAndFinalize: makeSpy(() => ({ merged: true })) }));

  assert.equal(spawnReviewSession.calls.length, 1, "exactly one spawn — for the fresh PR #11");
  assert.equal(spawnReviewSession.calls[0][0].number, 11, "the spawned review must be PR #11, not the already-reviewed #10");
});
