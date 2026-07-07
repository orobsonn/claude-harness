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
 *   6. Gate-machinery 2nd pass: `secondPassRequired = opts.touchesGateMachinery(changedFiles)`.
 *      When required, a SECOND review session is spawned and its verdict is read via
 *      `opts.getFreshVerdict(pr, sha, <a stateDir path containing the substring "second-pass">)`
 *      (e.g. `join(stateDir, "second-pass")`) → `secondPassClean`.
 *   7. `decision = opts.mergeEligible({freshVerdictClean, crossFamilyEligible, secondPassRequired,
 *      secondPassClean})` — THE conjunction (review-gate-hardening.mjs).
 *   8. Routing on `decision.eligible`:
 *        - `true`  → `opts.mergeAndFinalize(pr, sha, {...})`.
 *        - `false` && `!freshVerdictClean` → `opts.routeReject(pr, sha, {...})`.
 *        - `false` && `secondPassRequired && !secondPassClean` → `gh(["label","create",
 *          "harness:blocked","--force"])` THEN `gh(["issue","edit", <root>, ...,
 *          "--add-label","harness:blocked"])`, AND `opts.recordReviewed(pr.number, sha,
 *          {stateDir})` — a same-SHA re-review of a still-blocked PR must be a no-op.
 *        - `false` (residual: cross-family absent) → `gh(["label","create",
 *          "harness:awaiting-merge","--force"])` THEN `gh(["issue","edit", <root>, ...,
 *          "--add-label","harness:awaiting-merge"])`, AND `opts.recordReviewed(pr.number, sha,
 *          {stateDir})` — same idempotency guarantee while the PR sits awaiting merge.
 *
 * Every seam is injected as an in-memory fake/spy — no real `gh`/`git` process is ever spawned.
 * `isReviewEligible`, `touchesGateMachinery` and `mergeEligible` are the REAL modules (not fakes)
 * so a miscomputed input to the merge-boundary conjunction is caught by the real gate logic
 * instead of being hidden behind a permissive fake.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { cronReview } from "./cron-review.mjs";
import { isReviewEligible } from "./review-origin-gate.mjs";
import { mergeEligible, touchesGateMachinery } from "./review-gate-hardening.mjs";

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
    touchesGateMachinery,
    mergeEligible,
    spawnReviewSession: makeSpy(),
    notify: makeSpy(),
    stateDir: "/fake/state/review",
    authenticatedUser: "bot-user",
    engineKnows: () => true,
    recordReviewSession: makeSpy(),
    breakerTripped: () => false,
    alreadyReviewed: () => false,
    recordReviewed: makeSpy(),
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

test("cronReview: CONJUNCTION at the merge boundary — mergeAndFinalize is NEVER invoked unless fresh-CLEAN AND cross-family AND (2nd pass when required) all hold", async () => {
  // Sub-case A: fresh verdict CLEAN but crossFamilyEligible=false -> never merges, routes to awaiting-merge.
  {
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
  }

  // Sub-case B: a gate-machinery diff whose 2nd pass is BLOCKED -> never merges, routes to blocked.
  {
    const { gh, calls, setPr, setDiff } = makeFakeGh();
    setPr(31, { number: 31, headRefName: "harness/61", author: { login: "bot-user" }, labels: [], headSha: "sha-d" });
    setDiff(31, ["core/vps/cron-review.mjs"]); // matches the "core/vps/" gate-machinery glob
    const mergeAndFinalizeSpy = makeSpy();
    const getFreshVerdictTwoPass = (pr, sha, stateDir) =>
      stateDir.includes("second-pass")
        ? { status: "BLOCKED", finding: "gate-machinery regression" }
        : { status: "CLEAN" };

    await cronReview(
      baseOpts({
        gh,
        crossFamilyEligible: () => true, // present — isolates the 2nd-pass BLOCKED verdict as the sole blocker
        getFreshVerdict: getFreshVerdictTwoPass,
        mergeAndFinalize: mergeAndFinalizeSpy,
      })
    );

    assert.equal(
      mergeAndFinalizeSpy.calls.length,
      0,
      "[gate diff + 2nd pass BLOCKED] mergeAndFinalize must NEVER be invoked"
    );
    const routedBlocked = calls.some(
      (args) => args[0] === "issue" && args[1] === "edit" && args.includes("--add-label") && args.includes("harness:blocked")
    );
    assert.ok(routedBlocked, "[gate diff + 2nd pass BLOCKED] the PR's issue must be routed to harness:blocked");
  }
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

test("cronReview: 2nd-pass-blocked route records pr:sha", async () => {
  const stateDir = "/fake/state/review";
  const { gh, calls, setPr, setDiff } = makeFakeGh();
  const pr = { number: 41, headRefName: "harness/71", author: { login: "bot-user" }, labels: [], headSha: "sha-f" };
  setPr(pr.number, pr);
  setDiff(pr.number, ["core/vps/cron-review.mjs"]); // matches the "core/vps/" gate-machinery glob

  const getFreshVerdictTwoPass = (prArg, sha, sd) =>
    sd.includes("second-pass") ? { status: "BLOCKED", finding: "x" } : { status: "CLEAN" };
  const mergeAndFinalizeSpy = makeSpy();
  const recordReviewed = makeSpy();

  await cronReview(
    baseOpts({
      gh,
      stateDir,
      crossFamilyEligible: () => true, // present — isolates the 2nd-pass-blocked route as the sole blocker
      getFreshVerdict: getFreshVerdictTwoPass,
      mergeAndFinalize: mergeAndFinalizeSpy,
      recordReviewed,
    })
  );

  assert.equal(recordReviewed.calls.length, 1, "recordReviewed must be called once after the 2nd-pass-blocked route");
  const [recordedPrNumber, recordedSha, recordedMeta] = recordReviewed.calls[0];
  assert.equal(recordedPrNumber, pr.number, "recordReviewed must receive the PR number as the first arg");
  assert.equal(recordedSha, pr.headSha, "recordReviewed must receive the head SHA as the second arg");
  assert.equal(typeof recordedMeta, "object", "recordReviewed's third arg must be an object");
  assert.equal(recordedMeta.stateDir, stateDir, "recordReviewed's third arg must carry the stateDir");
  assert.equal(recordReviewed.calls[0].length, 3, "recordReviewed must be called with exactly 3 args");

  assert.equal(mergeAndFinalizeSpy.calls.length, 0, "mergeAndFinalize must NEVER be invoked on a 2nd-pass BLOCKED verdict");
  const routedBlocked = calls.some(
    (args) => args[0] === "issue" && args[1] === "edit" && args.includes("--add-label") && args.includes("harness:blocked")
  );
  assert.ok(routedBlocked, "the PR's issue must be routed to harness:blocked");
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
