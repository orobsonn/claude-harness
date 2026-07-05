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
 *          "--add-label","harness:blocked"])`.
 *        - `false` (residual: cross-family absent) → `gh(["label","create",
 *          "harness:awaiting-merge","--force"])` THEN `gh(["issue","edit", <root>, ...,
 *          "--add-label","harness:awaiting-merge"])`.
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

/** @description Assembles a full cronReview() opts object from defaults + per-test overrides. */
function baseOpts(overrides = {}) {
  return {
    isReviewEligible,
    getFreshVerdict: () => ({ status: "CLEAN" }),
    crossFamilyEligible: () => true,
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
    ...overrides,
  };
}

test("cronReview: reads the PR diff via `gh pr diff <n>` (or `gh api`) and NEVER checks out branch harness/<N>", () => {
  const { gh, calls, setPr, setDiff } = makeFakeGh();
  setPr(10, { number: 10, headRefName: "harness/42", author: { login: "bot-user" }, labels: [], headSha: "sha-a" });
  setDiff(10, ["src/foo.js"]);

  cronReview(baseOpts({ gh }));

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

test("cronReview: DRIVES reconciliation every cycle — reconcile is invoked independent of the open-PR loop", () => {
  const { gh } = makeFakeGh(); // no PRs set -> `gh pr list` returns []
  const reconcileSpy = makeSpy(() => []);

  cronReview(baseOpts({ gh, reconcile: reconcileSpy }));

  assert.ok(
    reconcileSpy.calls.length >= 1,
    "reconcile must be invoked during the cycle even when the open-PR list is empty — the self-heal is DRIVEN, not merely defined"
  );
});

test("cronReview: awaiting-merge label-create happens BEFORE the first relabel to harness:awaiting-merge", () => {
  const { gh, calls, setPr, setDiff } = makeFakeGh();
  setPr(20, { number: 20, headRefName: "harness/55", author: { login: "bot-user" }, labels: [], headSha: "sha-b" });
  setDiff(20, ["src/bar.js"]); // not gate machinery

  cronReview(
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

test("cronReview: CONJUNCTION at the merge boundary — mergeAndFinalize is NEVER invoked unless fresh-CLEAN AND cross-family AND (2nd pass when required) all hold", () => {
  // Sub-case A: fresh verdict CLEAN but crossFamilyEligible=false -> never merges, routes to awaiting-merge.
  {
    const { gh, calls, setPr, setDiff } = makeFakeGh();
    setPr(30, { number: 30, headRefName: "harness/60", author: { login: "bot-user" }, labels: [], headSha: "sha-c" });
    setDiff(30, ["src/baz.js"]); // not gate machinery
    const mergeAndFinalizeSpy = makeSpy();

    cronReview(
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

    cronReview(
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
