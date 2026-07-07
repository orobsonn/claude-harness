/**
 * @description Contract tests for review-merge.mjs (NOT YET IMPLEMENTED — this suite is
 * intentionally RED until the module ships). It pins the deterministic merge+finalize step that
 * cron-b's auto-merge path hands off to, plus a reconciliation pass that self-heals a harness
 * issue whose PR merged while a relabel step upstream (in-progress -> in-review -> done) failed
 * or was skipped.
 *
 * Pinned signatures the implementer MUST match:
 *
 *   mergeAndFinalize(pr, sha, opts) -> { merged: boolean }
 *     - pr: { number: number, headRefName: string }  — headRefName is "harness/<issueNumber>"
 *     - sha: string — the head SHA cron-b already fetched fresh for this PR
 *     - opts.gh: (args: string[]) => any — injected `gh` seam
 *     - opts.counter: { reset(issueNumber: number, o: {stateDir: string}): void }
 *     - opts.recordReviewed: (pr: number, sha: string, o: {stateDir: string}) => void
 *     - opts.stateDir: string
 *
 *     Behavior:
 *       1. Calls `gh(["pr", "merge", String(pr.number), "--squash", "--match-head-commit", sha])`
 *          FIRST — retrying a NOT-ok result up to a bounded number of attempts (default 3), spaced
 *          by `opts.sleep(ms)` (injectable; a real sync sleep in prod, a no-op in tests). This
 *          absorbs GitHub's async mergeability lag (a clean PR can report NOT-mergeable for a few
 *          seconds right after the review) without waiting a whole cron cycle.
 *       2. If the merge call is STILL NOT ok after the retries (`{ok:false}` or falsy): it classifies
 *          the failure via `gh(["pr", "view", String(pr.number), "--json", "mergeStateStatus,mergeable"])`.
 *          - `mergeStateStatus === "BEHIND"` (base advanced under a "require branches up to date"
 *            protection) is the ONLY auto-recoverable case: if the PR is under its update-attempt
 *            ceiling (`opts.counter.readUpdateAttempts(pr.number, {stateDir})` < `opts.maxUpdateAttempts`,
 *            default 3), it calls `gh(["pr", "update-branch", String(pr.number)])` (GitHub's native,
 *            non-force base-merge). On success it bumps `counter.incrementUpdateAttempt(pr.number,
 *            {stateDir})` and returns `{merged:false, updateAttempted:true, terminal:false}` — the head
 *            sha WILL change, so `alreadyReviewed` (keyed by sha) re-reviews the PR from scratch next
 *            cycle. It does NOT relabel, does NOT recordReviewed (stays re-reviewable). At/over the
 *            ceiling, OR if update-branch itself fails (a real conflict surfaced), it returns
 *            `{merged:false, terminal:true}`.
 *          - Any other failure (real conflict `DIRTY`/`CONFLICTING`, head moved, checks BLOCKED,
 *            unknown) returns `{merged:false, terminal:true}` WITHOUT attempting update-branch.
 *          In every non-merge outcome it does NOT relabel the issue, does NOT call counter.reset, does
 *          NOT call recordReviewed for this sha.
 *       3. If the merge call IS ok: derives the issue number from `pr.headRefName` (pattern
 *          `harness/<digits>`), then calls
 *          `gh(["issue", "edit", String(issueNumber), "--remove-label", "harness:in-review",
 *          "--add-label", "harness:done"])`, then `opts.counter.reset(issueNumber, {stateDir})`,
 *          then `opts.recordReviewed(pr.number, sha, {stateDir})`, then returns `{merged:true}`.
 *          The merge call's index in the `gh` calls log MUST be strictly before the relabel
 *          call's index.
 *
 *   reconcile(opts) -> Array<{issue: number, from: string}>
 *     - opts.gh: (args: string[]) => any — injected `gh` seam
 *     - opts.counter: { reset(issueNumber: number, o: {stateDir: string}): void }
 *     - opts.stateDir: string
 *     - opts.labels: string[] (optional) — non-terminal labels to scan; defaults to
 *       `["harness:in-progress", "harness:in-review", "harness:awaiting-merge"]` (the widened
 *       non-terminal set — a harness PR observed MERGED while its issue still carries ANY of
 *       these must self-heal to harness:done, regardless of which upstream relabel step failed).
 *
 *     Behavior, for EACH label in the scanned set (in order):
 *       1. Calls `gh(["issue", "list", "--label", label, "--json", "number,labels"])` and gets
 *          back the issues CURRENTLY carrying that label (a stateful `gh` fake must stop
 *          returning an issue here once its label has changed — this is what makes a repeat
 *          reconcile() pass a no-op).
 *       2. For each returned issue `{number}`, calls
 *          `gh(["pr", "list", "--head", "harness/" + number, "--state", "merged", "--json",
 *          "number,state"])`. If that returns a non-empty array (a merged harness PR exists for
 *          this issue), the issue is reconcilable.
 *       3. For each reconcilable issue: calls
 *          `gh(["issue", "edit", String(number), "--remove-label", label, "--add-label",
 *          "harness:done"])`, then `opts.counter.reset(number, {stateDir})`, and pushes
 *          `{issue: number, from: label}` onto the returned array.
 *
 * Every external seam (`gh`, `counter`, `recordReviewed`) is injected as an in-memory fake so
 * these tests are fully hermetic — no real `gh` process is ever spawned. Assertions are made on
 * the observable, ORDERED `gh` calls log and on each fake's own recorded-calls arrays, following
 * this repo's seam-injection style (see cron-a-exit.test.mjs, cron-b.test.mjs).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { mergeAndFinalize, reconcile } from "./review-merge.mjs";

const STATE_DIR = "/fake/state";

/**
 * @description Fake `gh` seam for mergeAndFinalize tests. Records every invocation's argv into
 * `calls` (in call order). `gh pr merge ... --match-head-commit <sha>` answers with `mergeResult`.
 * `gh pr view <n> --json mergeStateStatus,mergeable` answers with `opts.viewResult` (the merge-
 * failure classification), and `gh pr update-branch <n>` with `opts.updateResult`. Every other
 * subcommand (`issue edit`, etc.) is just recorded and answers `{ok:true}`.
 * @param {{ok: boolean}} mergeResult
 * @param {{viewResult?: object, updateResult?: {ok: boolean}}} [opts]
 */
function makeFakeMergeGh(mergeResult, { viewResult = { ok: true }, updateResult = { ok: true } } = {}) {
  const calls = [];
  function gh(args) {
    calls.push(args);
    if (args[0] === "pr" && args[1] === "merge") return mergeResult;
    if (args[0] === "pr" && args[1] === "view") return viewResult;
    if (args[0] === "pr" && args[1] === "update-branch") return updateResult;
    return { ok: true };
  }
  return { gh, calls };
}

/**
 * @description Fake counter seam mirroring cron-state.mjs's reset(issue, opts) contract PLUS the
 * update-branch attempt counter (readUpdateAttempts / incrementUpdateAttempt / resetUpdateAttempts,
 * keyed by PR number). Tracks every call so a test can assert what fired. `updateAttemptsSeed` sets
 * the starting count so a test can drive the ceiling path without looping.
 * @param {{updateAttemptsSeed?: number}} [o]
 */
function makeFakeCounter({ updateAttemptsSeed = 0 } = {}) {
  const resetCalls = [];
  let updateAttempts = updateAttemptsSeed;
  const incrementUpdateCalls = [];
  const resetUpdateCalls = [];
  return {
    reset(issueNumber, opts) {
      resetCalls.push({ issueNumber, opts });
    },
    readUpdateAttempts() {
      return updateAttempts;
    },
    incrementUpdateAttempt(prNumber, opts) {
      updateAttempts += 1;
      incrementUpdateCalls.push({ prNumber, opts });
    },
    resetUpdateAttempts(prNumber, opts) {
      updateAttempts = 0;
      resetUpdateCalls.push({ prNumber, opts });
    },
    resetCalls,
    incrementUpdateCalls,
    resetUpdateCalls,
  };
}

/** @description Finds a `gh pr update-branch <n>` call index in a calls log. */
function findUpdateBranchCall(calls, number) {
  return calls.findIndex(
    (args) => Array.isArray(args) && args[0] === "pr" && args[1] === "update-branch" && args[2] === String(number)
  );
}

/**
 * @description Fake recordReviewed seam mirroring cron-state.mjs's recordReviewed(pr, sha, opts)
 * contract. Tracks every call so a test can assert a moved-head merge failure never marks that
 * sha as reviewed.
 */
function makeFakeRecordReviewed() {
  const calls = [];
  function recordReviewed(pr, sha, opts) {
    calls.push({ pr, sha, opts });
  }
  return { recordReviewed, calls };
}

/**
 * @description Fake stateful `gh` seam for reconcile() tests. Holds an in-memory issue -> label
 * map and a set of issue numbers whose `harness/<n>` branch has an already-merged PR. Answers
 * `issue list --label <label>` with only the issues CURRENTLY carrying that label, and answers
 * `pr list --head harness/<n> --state merged` with a merged PR entry only for issues in the
 * merged set. `issue edit ... --add-label X` MUTATES the internal label map so a second
 * reconcile() pass observes the post-relabel state — this is what makes repeat passes
 * idempotent under test, without any extra seam.
 * @param {Record<number, string>} initialLabels — issue number -> current label
 * @param {number[]} mergedIssueNumbers — issues whose harness/<n> PR is already merged
 */
function makeFakeReconcileGh(initialLabels, mergedIssueNumbers) {
  const calls = [];
  const labelByIssue = new Map(Object.entries(initialLabels).map(([k, v]) => [Number(k), v]));
  const mergedIssues = new Set(mergedIssueNumbers);

  function gh(args) {
    calls.push(args);

    if (args[0] === "issue" && args[1] === "list" && args[2] === "--label") {
      const label = args[3];
      const numbers = [...labelByIssue.entries()].filter(([, currentLabel]) => currentLabel === label).map(([n]) => n);
      return numbers.map((number) => ({ number, labels: [{ name: labelByIssue.get(number) }] }));
    }

    if (args[0] === "pr" && args[1] === "list" && args[2] === "--head") {
      const headRefName = args[3];
      const match = /^harness\/(\d+)$/.exec(headRefName ?? "");
      const number = match ? Number(match[1]) : null;
      if (number !== null && mergedIssues.has(number)) {
        return [{ number, state: "MERGED" }];
      }
      return [];
    }

    if (args[0] === "issue" && args[1] === "edit") {
      const number = Number(args[2]);
      const addIndex = args.indexOf("--add-label");
      if (addIndex !== -1) {
        labelByIssue.set(number, args[addIndex + 1]);
      }
      return { ok: true };
    }

    return { ok: true };
  }

  return { gh, calls, labelByIssue };
}

/** @description Finds a `gh pr merge <n> --squash --match-head-commit <sha>` call in a calls log. */
function findMergeCall(calls, { number, sha }) {
  return calls.findIndex(
    (args) =>
      Array.isArray(args) &&
      args[0] === "pr" &&
      args[1] === "merge" &&
      args[2] === String(number) &&
      args.includes("--match-head-commit") &&
      args[args.indexOf("--match-head-commit") + 1] === sha
  );
}

/**
 * @description Finds a `gh issue edit <n> ... --add-label Y` relabel call in a calls log where
 * `removeLabel` is AMONG the stripped labels. The transition-to-done relabel now strips the full
 * mutually-exclusive state set in one call, so `removeLabel` may not be the FIRST `--remove-label`
 * pair — scan every pair for membership rather than only the first.
 */
function findRelabelCallIndex(calls, { number, removeLabel, addLabel }) {
  const stripsLabel = (args, label) =>
    args.some((tok, i) => tok === "--remove-label" && args[i + 1] === label);
  return calls.findIndex(
    (args) =>
      Array.isArray(args) &&
      args[0] === "issue" &&
      args[1] === "edit" &&
      args[2] === String(number) &&
      stripsLabel(args, removeLabel) &&
      args.includes("--add-label") &&
      args[args.indexOf("--add-label") + 1] === addLabel
  );
}

/** @description Counts `gh issue edit <n> ...` calls (any labels) for a given issue number in a calls log. */
function countEditCallsForIssue(calls, number) {
  return calls.filter(
    (args) => Array.isArray(args) && args[0] === "issue" && args[1] === "edit" && args[2] === String(number)
  ).length;
}

/** @description True if any recorded gh call adds the given label (regardless of which call). */
function anyRelabelAdds(calls, label) {
  return calls.some(
    (args) => Array.isArray(args) && args.includes("--add-label") && args[args.indexOf("--add-label") + 1] === label
  );
}

test("mergeAndFinalize: CLEAN verdict + unchanged head -> merge --match-head-commit fires FIRST, then issue relabels in-review->done, then counter.reset; merge index < relabel index", () => {
  const sha = "abc1234def5678";
  const pr = { number: 7, headRefName: "harness/42" };
  const { gh, calls } = makeFakeMergeGh({ ok: true });
  const counter = makeFakeCounter();
  const { recordReviewed, calls: recordedCalls } = makeFakeRecordReviewed();

  const result = mergeAndFinalize(pr, sha, { gh, counter, recordReviewed, stateDir: STATE_DIR });

  assert.equal(result.merged, true, "a successful merge must report merged:true");

  const mergeIndex = findMergeCall(calls, { number: pr.number, sha });
  assert.notEqual(mergeIndex, -1, "must call `gh pr merge 7 --squash --match-head-commit <sha>`");

  const relabelIndex = findRelabelCallIndex(calls, {
    number: 42,
    removeLabel: "harness:in-review",
    addLabel: "harness:done",
  });
  assert.notEqual(relabelIndex, -1, "must relabel the issue harness:in-review -> harness:done after a successful merge");

  assert.ok(mergeIndex < relabelIndex, "the merge call must happen BEFORE the relabel call");

  assert.equal(counter.resetCalls.length, 1, "counter.reset must be called exactly once after a successful merge");
  assert.equal(counter.resetCalls[0].issueNumber, 42, "counter.reset must target the issue number, not the PR number");

  assert.equal(recordedCalls.length, 1, "recordReviewed must be called exactly once after a successful merge");
  assert.deepEqual(
    [recordedCalls[0].pr, recordedCalls[0].sha],
    [pr.number, sha],
    "recordReviewed must be called with the PR number and the merged head sha"
  );
});

test("mergeAndFinalize: head moved (merge rejects, not BEHIND) -> terminal:true, NO update-branch, recordReviewed NOT called, issue NOT relabeled", () => {
  const sha = "stale-sha-0000";
  const pr = { number: 9, headRefName: "harness/99" };
  // viewResult carries no BEHIND status (head moved / unknown) — must not attempt update-branch.
  const { gh, calls } = makeFakeMergeGh({ ok: false }, { viewResult: { mergeStateStatus: "UNKNOWN" } });
  const counter = makeFakeCounter();
  const { recordReviewed, calls: recordedCalls } = makeFakeRecordReviewed();

  const result = mergeAndFinalize(pr, sha, { gh, counter, recordReviewed, stateDir: STATE_DIR, sleep: () => {} });

  assert.equal(result.merged, false, "a rejected merge must report merged:false");
  assert.equal(result.terminal, true, "a non-BEHIND merge failure is terminal — routes to manual merge");

  const mergeIndex = findMergeCall(calls, { number: pr.number, sha });
  assert.notEqual(mergeIndex, -1, "the merge command must still be ATTEMPTED with --match-head-commit even though it will fail");

  assert.equal(findUpdateBranchCall(calls, pr.number), -1, "update-branch must NOT be attempted for a non-BEHIND failure");
  assert.equal(recordedCalls.length, 0, "recordReviewed must NOT be called for this sha — the PR must stay re-reviewable next pass");
  assert.equal(anyRelabelAdds(calls, "harness:done"), false, "the issue must NOT be relabeled to harness:done when the merge was rejected");
  assert.equal(counter.resetCalls.length, 0, "counter.reset must NOT be called when the merge was rejected");
});

test("mergeAndFinalize: merge fails with mergeStateStatus BEHIND -> calls update-branch, returns {updateAttempted:true, terminal:false}, bumps update counter, does NOT recordReviewed/relabel", () => {
  const sha = "behind-sha-1";
  const pr = { number: 21, headRefName: "harness/210" };
  const { gh, calls } = makeFakeMergeGh({ ok: false }, { viewResult: { mergeStateStatus: "BEHIND", mergeable: "MERGEABLE" }, updateResult: { ok: true } });
  const counter = makeFakeCounter();
  const { recordReviewed, calls: recordedCalls } = makeFakeRecordReviewed();

  const result = mergeAndFinalize(pr, sha, { gh, counter, recordReviewed, stateDir: STATE_DIR, sleep: () => {} });

  assert.equal(result.merged, false, "the PR did not merge this pass");
  assert.equal(result.updateAttempted, true, "a BEHIND branch must have update-branch attempted");
  assert.equal(result.terminal, false, "a successful update-branch is NOT terminal — the PR re-reviews next cycle at its new sha");
  assert.notEqual(findUpdateBranchCall(calls, pr.number), -1, "must call `gh pr update-branch 21`");
  assert.equal(counter.incrementUpdateCalls.length, 1, "the update-branch attempt counter must be bumped once");
  assert.equal(counter.incrementUpdateCalls[0].prNumber, pr.number, "the update-attempt counter is keyed by PR number");
  assert.equal(recordedCalls.length, 0, "recordReviewed must NOT fire — the sha will change, alreadyReviewed must re-review it");
  assert.equal(anyRelabelAdds(calls, "harness:done"), false, "an update-branch retry must NOT relabel the issue to done");
});

test("mergeAndFinalize: merge fails with a real conflict (DIRTY) -> terminal:true, update-branch NOT attempted", () => {
  const sha = "dirty-sha-1";
  const pr = { number: 22, headRefName: "harness/220" };
  const { gh, calls } = makeFakeMergeGh({ ok: false }, { viewResult: { mergeStateStatus: "DIRTY", mergeable: "CONFLICTING" } });
  const counter = makeFakeCounter();
  const { recordReviewed, calls: recordedCalls } = makeFakeRecordReviewed();

  const result = mergeAndFinalize(pr, sha, { gh, counter, recordReviewed, stateDir: STATE_DIR, sleep: () => {} });

  assert.equal(result.merged, false);
  assert.equal(result.terminal, true, "a real content conflict is terminal — only a human resolves it");
  assert.equal(findUpdateBranchCall(calls, pr.number), -1, "update-branch must NOT be attempted on a real conflict (it would fail anyway)");
  assert.equal(recordedCalls.length, 0);
});

test("mergeAndFinalize: BEHIND but update-branch itself fails (a conflict surfaced while merging the base) -> terminal:true", () => {
  const sha = "behind-then-conflict";
  const pr = { number: 23, headRefName: "harness/230" };
  const { gh, calls } = makeFakeMergeGh({ ok: false }, { viewResult: { mergeStateStatus: "BEHIND" }, updateResult: { ok: false } });
  const counter = makeFakeCounter();
  const { recordReviewed } = makeFakeRecordReviewed();

  const result = mergeAndFinalize(pr, sha, { gh, counter, recordReviewed, stateDir: STATE_DIR, sleep: () => {} });

  assert.notEqual(findUpdateBranchCall(calls, pr.number), -1, "update-branch must be attempted for a BEHIND branch");
  assert.equal(result.terminal, true, "a failed update-branch (real conflict emerged) is terminal");
  assert.equal(result.updateAttempted, undefined, "a FAILED update-branch is not a successful retry — do not signal updateAttempted");
  assert.equal(counter.incrementUpdateCalls.length, 0, "a failed update-branch must not bump the retry counter");
});

test("mergeAndFinalize: BEHIND but already at the update-attempt ceiling -> terminal:true, update-branch NOT attempted again (two colliding PRs cannot loop forever)", () => {
  const sha = "behind-at-ceiling";
  const pr = { number: 24, headRefName: "harness/240" };
  const { gh, calls } = makeFakeMergeGh({ ok: false }, { viewResult: { mergeStateStatus: "BEHIND" }, updateResult: { ok: true } });
  const counter = makeFakeCounter({ updateAttemptsSeed: 3 }); // already at the default ceiling of 3
  const { recordReviewed } = makeFakeRecordReviewed();

  const result = mergeAndFinalize(pr, sha, { gh, counter, recordReviewed, stateDir: STATE_DIR, sleep: () => {}, maxUpdateAttempts: 3 });

  assert.equal(result.terminal, true, "at the update-attempt ceiling the PR becomes terminal (manual merge)");
  assert.equal(findUpdateBranchCall(calls, pr.number), -1, "update-branch must NOT be attempted once the ceiling is reached");
  assert.equal(counter.incrementUpdateCalls.length, 0, "no further update-attempt is counted at the ceiling");
});

test("mergeAndFinalize: a successful merge also resets the update-attempt counter for the PR", () => {
  const sha = "clean-sha-reset";
  const pr = { number: 25, headRefName: "harness/250" };
  const { gh } = makeFakeMergeGh({ ok: true });
  const counter = makeFakeCounter({ updateAttemptsSeed: 2 });
  const { recordReviewed } = makeFakeRecordReviewed();

  const result = mergeAndFinalize(pr, sha, { gh, counter, recordReviewed, stateDir: STATE_DIR });

  assert.equal(result.merged, true);
  assert.equal(counter.resetUpdateCalls.length, 1, "a merged PR must reset its update-attempt counter so a future re-use starts clean");
  assert.equal(counter.resetUpdateCalls[0].prNumber, pr.number);
});

test("reconcile: harness PR observed MERGED while its issue is still harness:in-review -> relabels ->done + counter reset; a repeat run is a no-op", () => {
  const { gh, calls } = makeFakeReconcileGh({ 55: "harness:in-review" }, [55]);
  const counter = makeFakeCounter();

  const firstPass = reconcile({ gh, counter, stateDir: STATE_DIR });

  assert.deepEqual(
    firstPass,
    [{ issue: 55, from: "harness:in-review" }],
    "the first reconcile pass must report the issue reconciled from harness:in-review"
  );

  const relabelIndex = findRelabelCallIndex(calls, {
    number: 55,
    removeLabel: "harness:in-review",
    addLabel: "harness:done",
  });
  assert.notEqual(relabelIndex, -1, "must relabel the issue harness:in-review -> harness:done");
  assert.equal(counter.resetCalls.length, 1, "counter.reset must be called exactly once on the first pass");
  assert.equal(counter.resetCalls[0].issueNumber, 55);

  const secondPass = reconcile({ gh, counter, stateDir: STATE_DIR });

  assert.deepEqual(secondPass, [], "a repeat reconcile pass must be a no-op — the issue is already harness:done");
  assert.equal(
    countEditCallsForIssue(calls, 55),
    1,
    "a repeat reconcile pass must NOT issue a second `gh issue edit` for an issue already reconciled to harness:done"
  );
  assert.equal(counter.resetCalls.length, 1, "counter.reset must NOT be called again on the idempotent repeat pass");
});

test("reconcile: harness PR observed MERGED while its issue is still harness:in-progress (widened non-terminal set self-heals) -> relabels ->done + counter reset", () => {
  const { gh, calls } = makeFakeReconcileGh({ 61: "harness:in-progress" }, [61]);
  const counter = makeFakeCounter();

  const result = reconcile({ gh, counter, stateDir: STATE_DIR });

  assert.deepEqual(
    result,
    [{ issue: 61, from: "harness:in-progress" }],
    "reconcile must self-heal an issue stuck in harness:in-progress whose PR already merged"
  );

  const relabelIndex = findRelabelCallIndex(calls, {
    number: 61,
    removeLabel: "harness:in-progress",
    addLabel: "harness:done",
  });
  assert.notEqual(
    relabelIndex,
    -1,
    "must relabel the issue harness:in-progress -> harness:done (widened non-terminal set: in-progress, in-review, awaiting-merge)"
  );
  assert.equal(counter.resetCalls.length, 1, "counter.reset must be called exactly once");
  assert.equal(counter.resetCalls[0].issueNumber, 61);
});

test("mergeAndFinalize: transient merge failure (GitHub mergeability lag) is retried and merges on a later attempt", () => {
  const sha = "clean-sha-1111";
  const pr = { number: 12, headRefName: "harness/120" };
  let mergeAttempts = 0;
  const gh = (args) => {
    if (args[0] === "pr" && args[1] === "merge") {
      mergeAttempts += 1;
      return { ok: mergeAttempts >= 2 }; // first attempt fails (mergeability still computing), then succeeds
    }
    return { ok: true };
  };
  const counter = makeFakeCounter();
  const { recordReviewed, calls: recordedCalls } = makeFakeRecordReviewed();
  let slept = 0;

  const result = mergeAndFinalize(pr, sha, {
    gh,
    counter,
    recordReviewed,
    stateDir: STATE_DIR,
    sleep: () => { slept += 1; },
  });

  assert.equal(result.merged, true, "a transient first-attempt failure must be retried and merge on a later attempt");
  assert.ok(mergeAttempts >= 2, "the merge must be retried after a transient failure, not given up on immediately");
  assert.ok(slept >= 1, "retries must be spaced by a sleep");
  assert.equal(recordedCalls.length, 1, "recordReviewed is called once the retry succeeds");
});
