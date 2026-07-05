/**
 * @description Contract tests for cron-a-select.mjs — the VPS cron harness's Cron A ENTRYPOINT
 * (task-4), the single scheduled job. cronASelect() must, in order: (1) acquire the per-project
 * run-lock as the FIRST action (before any `gh` query) — no TOCTOU window; (2) ensure the
 * `harness:blocked` label exists (idempotent `gh label create harness:blocked --force`); (3) query
 * open `harness:ready` issues, excluding any also carrying `harness:in-progress` or
 * `harness:blocked`, and pick the OLDEST eligible one; (4) with no eligible issue, release the lock
 * and exit WITHOUT calling dispatch; (5) otherwise relabel the picked issue `harness:ready` ->
 * `harness:in-progress` BEFORE any worktree/session creation, then invoke cron-a-dispatch (task-5),
 * handing it the chosen issue and the ALREADY-HELD run-lock handle acquire() returned (dispatch
 * never re-acquires).
 *
 * Every seam cronASelect needs — the run-lock acquire/release, `gh`, and cron-a-dispatch itself —
 * is INJECTED as a fake so these tests are fully hermetic: no real git/gh/tmux/process is ever
 * spawned. All three fakes push into the SAME shared `callLog` array, which is how cross-seam
 * ORDER (acquire before the first `gh issue list`; relabel before dispatch/worktree/session) is
 * asserted as an observable, without ever running real subprocesses or spawning real
 * worktrees/tmux sessions (those are modeled entirely as "dispatch was invoked").
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { cronASelect } from "./cron-a-select.mjs";

/** @description Fresh shared ordered call log every seam fake below pushes entries into. */
function makeCallLog() {
  return [];
}

/**
 * @description Fake run-lock seam. acquire() and release() both push into the shared callLog so
 * cross-seam ORDER (acquire before the first gh call) can be asserted. `acquireResult` lets a test
 * model either a fresh acquire (`{ acquired: true, acquireTs }`) or a live lock already held
 * elsewhere (`{ acquired: false }`).
 */
function makeFakeRunLock(callLog, { acquireResult = { acquired: true, acquireTs: 4242 } } = {}) {
  const acquireCalls = [];
  const releaseCalls = [];
  return {
    acquire(opts) {
      const entry = { type: "lock-acquire", opts };
      callLog.push(entry);
      acquireCalls.push(opts);
      return acquireResult;
    },
    release(opts) {
      callLog.push({ type: "lock-release", opts });
      releaseCalls.push(opts);
    },
    acquireCalls,
    releaseCalls,
  };
}

/**
 * @description Fake `gh` seam. Records every invocation into the shared callLog as
 * `{ type: "gh", args }` (mirroring cron-a-dispatch.test.mjs's plain-argv gh fake). Answers
 * `gh issue list` with the injected `issues` set (each `{ number, labels }`); every other
 * invocation (label create, issue edit) returns `{ ok: true }`.
 */
function makeFakeGh(callLog, { issues = [], mergedDeps = new Set() } = {}) {
  function gh(args) {
    callLog.push({ type: "gh", args });
    if (args[0] === "issue" && args[1] === "list") {
      return issues;
    }
    // Dependency-gate ground truth: a merged PR on `harness/<dep>` iff dep ∈ mergedDeps.
    if (args[0] === "pr" && args[1] === "list" && args.includes("--head") && args.includes("merged")) {
      const head = args[args.indexOf("--head") + 1];
      const n = Number(String(head).replace("harness/", ""));
      return mergedDeps.has(n) ? [{ number: 900 + n }] : [];
    }
    return { ok: true };
  }
  return gh;
}

/**
 * @description Fake cron-a-dispatch (task-5) seam. Records its (issue, lock) args into the shared
 * callLog as `{ type: "dispatch", issue, lock }` — this is how tests assert dispatch received the
 * SAME lock object acquire() returned, never a re-acquired one.
 */
function makeFakeDispatch(callLog) {
  function dispatch(issue, lock) {
    callLog.push({ type: "dispatch", issue, lock });
    return { ok: true };
  }
  return dispatch;
}

/** @description Assembles a full cronASelect() opts object from defaults + per-test overrides. */
function baseOpts({
  project = "demo-project",
  stateDir = "/tmp/cron-a-select-fixture-state",
  runLock,
  gh,
  dispatch,
}) {
  return { project, stateDir, runLock, gh, dispatch };
}

/** @description Indices of every gh-list call in the shared callLog (there should be at most one). */
function ghListIndex(callLog) {
  return callLog.findIndex((e) => e.type === "gh" && e.args[0] === "issue" && e.args[1] === "list");
}

/** @description Index of the first `gh label create harness:blocked --force` call. */
function labelCreateIndex(callLog) {
  return callLog.findIndex(
    (e) => e.type === "gh" && e.args[0] === "label" && e.args[1] === "create" && e.args.includes("harness:blocked")
  );
}

/** @description Index(es) of every `gh issue edit <n> ...` relabel call targeting a given issue number. */
function relabelIndicesFor(callLog, issueNumber) {
  return callLog
    .map((e, i) => ({ e, i }))
    .filter(
      ({ e }) =>
        e.type === "gh" &&
        e.args[0] === "issue" &&
        e.args[1] === "edit" &&
        e.args[2] === String(issueNumber)
    )
    .map(({ i }) => i);
}

test("cronASelect: acquires the run-lock as index 0 in the shared call log, strictly before the first `gh issue list` invocation (no TOCTOU window)", () => {
  const callLog = makeCallLog();
  const runLock = makeFakeRunLock(callLog);
  const gh = makeFakeGh(callLog, { issues: [] });
  const dispatch = makeFakeDispatch(callLog);

  cronASelect(baseOpts({ runLock, gh, dispatch }));

  assert.equal(callLog[0].type, "lock-acquire", "run-lock acquire() must be the very first recorded action");
  const listIdx = ghListIndex(callLog);
  assert.notEqual(listIdx, -1, "cronASelect must call `gh issue list`");
  assert.ok(0 < listIdx, "acquire() (index 0) must occur strictly before the first `gh issue list` call");
});

test("cronASelect: invokes `gh label create harness:blocked --force` before selecting any issue (before the issue-list query)", () => {
  const callLog = makeCallLog();
  const runLock = makeFakeRunLock(callLog);
  const gh = makeFakeGh(callLog, { issues: [{ number: 1, labels: ["harness:ready"] }] });
  const dispatch = makeFakeDispatch(callLog);

  cronASelect(baseOpts({ runLock, gh, dispatch }));

  const createIdx = labelCreateIndex(callLog);
  assert.notEqual(createIdx, -1, "cronASelect must invoke gh label create harness:blocked --force");
  const createCall = callLog[createIdx];
  assert.ok(
    createCall.args.includes("--force"),
    "the label-create invocation must be idempotent via --force"
  );
  const listIdx = ghListIndex(callLog);
  assert.notEqual(listIdx, -1, "cronASelect must call `gh issue list`");
  assert.ok(createIdx < listIdx, "label create must happen before selecting any issue (before the issue-list query)");
});

test("cronASelect: given A(ready), B(ready+in-progress), C(ready+blocked), the relabel gh call targets A only — never B or C", () => {
  const callLog = makeCallLog();
  const runLock = makeFakeRunLock(callLog);
  const issues = [
    { number: 1, labels: ["harness:ready"] },
    { number: 2, labels: ["harness:ready", "harness:in-progress"] },
    { number: 3, labels: ["harness:ready", "harness:blocked"] },
  ];
  const gh = makeFakeGh(callLog, { issues });
  const dispatch = makeFakeDispatch(callLog);

  cronASelect(baseOpts({ runLock, gh, dispatch }));

  const relabelA = relabelIndicesFor(callLog, 1);
  const relabelB = relabelIndicesFor(callLog, 2);
  const relabelC = relabelIndicesFor(callLog, 3);

  assert.equal(relabelA.length, 1, "issue A (harness:ready only) must be relabeled exactly once");
  assert.equal(relabelB.length, 0, "issue B (already harness:in-progress) must never be targeted by a relabel gh call");
  assert.equal(relabelC.length, 0, "issue C (already harness:blocked) must never be targeted by a relabel gh call");
});

test("cronASelect: the relabel gh call for the picked issue occurs BEFORE dispatch is invoked (relabel precedes any worktree/session spawn)", () => {
  const callLog = makeCallLog();
  const runLock = makeFakeRunLock(callLog);
  const gh = makeFakeGh(callLog, { issues: [{ number: 7, labels: ["harness:ready"] }] });
  const dispatch = makeFakeDispatch(callLog);

  cronASelect(baseOpts({ runLock, gh, dispatch }));

  const relabelIdx = relabelIndicesFor(callLog, 7)[0];
  const dispatchIdx = callLog.findIndex((e) => e.type === "dispatch");

  assert.notEqual(relabelIdx, undefined, "the picked issue must be relabeled");
  assert.notEqual(dispatchIdx, -1, "dispatch must be invoked for the picked issue");
  assert.ok(
    relabelIdx < dispatchIdx,
    "the relabel gh call must be recorded BEFORE the dispatch invocation (relabel precedes spawn)"
  );
});

test("cronASelect: fetches the issue body and passes it to dispatch (dispatch needs it for the claude -p prompt file)", () => {
  const callLog = makeCallLog();
  const runLock = makeFakeRunLock(callLog);
  const gh = makeFakeGh(callLog, {
    issues: [{ number: 7, labels: ["harness:ready"], body: "the issue body\nwith detail" }],
  });
  const dispatch = makeFakeDispatch(callLog);

  cronASelect(baseOpts({ runLock, gh, dispatch }));

  // The list query MUST request `body` — dispatch writes it to the prompt file it feeds `claude -p`.
  const listCall = callLog.find((e) => e.type === "gh" && e.args[0] === "issue" && e.args[1] === "list");
  const jsonFields = listCall.args[listCall.args.indexOf("--json") + 1].split(",");
  assert.ok(jsonFields.includes("body"), "the gh issue list --json fields must include `body`");

  const dispatchEntry = callLog.find((e) => e.type === "dispatch");
  assert.equal(
    dispatchEntry.issue.body,
    "the issue body\nwith detail",
    "dispatch must receive the picked issue's body (else the spawn writes an undefined prompt file)"
  );
});

test("cronASelect: with no open harness:ready issue left after excluding in-progress/blocked, the run-lock is released and dispatch is NEVER called (no relabel either)", () => {
  const callLog = makeCallLog();
  const runLock = makeFakeRunLock(callLog);
  const issues = [
    { number: 2, labels: ["harness:ready", "harness:in-progress"] },
    { number: 3, labels: ["harness:ready", "harness:blocked"] },
  ];
  const gh = makeFakeGh(callLog, { issues });
  const dispatch = makeFakeDispatch(callLog);

  cronASelect(baseOpts({ runLock, gh, dispatch }));

  assert.equal(runLock.releaseCalls.length, 1, "a fire with no eligible work must release the run-lock exactly once");
  assert.equal(
    callLog.some((e) => e.type === "dispatch"),
    false,
    "dispatch must never be invoked when there is no eligible issue"
  );
  assert.equal(
    callLog.some((e) => e.type === "gh" && e.args[0] === "issue" && e.args[1] === "edit"),
    false,
    "no relabel gh call may occur on the no-work path"
  );
});

test("cronASelect: dispatch is called exactly once with the chosen issue and the SAME already-held run-lock handle acquire() returned; with no eligible issue, dispatch is never called and the lock is released", () => {
  // Scenario A: an eligible issue exists — dispatch must receive the exact lock object/acquireTs.
  const callLogA = makeCallLog();
  const acquireResult = { acquired: true, acquireTs: 99887 };
  const runLockA = makeFakeRunLock(callLogA, { acquireResult });
  const issueA = { number: 55, labels: ["harness:ready"] };
  const ghA = makeFakeGh(callLogA, { issues: [issueA] });
  const dispatchA = makeFakeDispatch(callLogA);

  cronASelect(baseOpts({ runLock: runLockA, gh: ghA, dispatch: dispatchA }));

  const dispatchCalls = callLogA.filter((e) => e.type === "dispatch");
  assert.equal(dispatchCalls.length, 1, "dispatch must be called exactly once");
  assert.equal(dispatchCalls[0].issue.number, 55, "dispatch must receive the chosen issue (55)");
  assert.equal(
    dispatchCalls[0].lock,
    acquireResult,
    "dispatch must receive the SAME lock object acquire() returned — never a re-acquired one"
  );
  assert.equal(
    dispatchCalls[0].lock.acquireTs,
    99887,
    "the handed-off lock's acquireTs must match the one acquire() produced"
  );

  // Scenario B: no open harness:ready issue — dispatch never called, lock released.
  const callLogB = makeCallLog();
  const runLockB = makeFakeRunLock(callLogB);
  const ghB = makeFakeGh(callLogB, { issues: [] });
  const dispatchB = makeFakeDispatch(callLogB);

  cronASelect(baseOpts({ runLock: runLockB, gh: ghB, dispatch: dispatchB }));

  assert.equal(
    callLogB.some((e) => e.type === "dispatch"),
    false,
    "the no-work path must never hand off to dispatch"
  );
  assert.equal(runLockB.releaseCalls.length, 1, "the no-work path must release the run-lock exactly once");
});

test("cronASelect: an issue carrying BOTH harness:ready and harness:in-review is EXCLUDED from the eligible set (never picked/re-dispatched while under review)", () => {
  const callLog = makeCallLog();
  const runLock = makeFakeRunLock(callLog);
  const issues = [{ number: 9, labels: ["harness:ready", "harness:in-review"] }];
  const gh = makeFakeGh(callLog, { issues });
  const dispatch = makeFakeDispatch(callLog);

  const result = cronASelect(baseOpts({ runLock, gh, dispatch }));

  assert.equal(
    callLog.some((e) => e.type === "dispatch"),
    false,
    "an issue that is both harness:ready and harness:in-review must never be dispatched"
  );
  assert.equal(
    relabelIndicesFor(callLog, 9).length,
    0,
    "an in-review issue must never be relabeled/re-dispatched"
  );
  assert.equal(
    runLock.releaseCalls.length,
    1,
    "with the only candidate excluded (in-review), no work is found and the run-lock must be released"
  );
  assert.equal(
    result.dispatched,
    false,
    "cronASelect must report no dispatch when the sole candidate is under review"
  );
});

test("cronASelect: an issue carrying ONLY harness:ready (no in-review) stays in the eligible set and is picked", () => {
  const callLog = makeCallLog();
  const runLock = makeFakeRunLock(callLog);
  const issue = { number: 11, labels: ["harness:ready"] };
  const gh = makeFakeGh(callLog, { issues: [issue] });
  const dispatch = makeFakeDispatch(callLog);

  const result = cronASelect(baseOpts({ runLock, gh, dispatch }));

  assert.equal(
    result.dispatched,
    true,
    "a plain harness:ready issue (no in-review) must be picked and dispatched"
  );
  assert.equal(result.issue.number, 11, "the eligible plain-ready issue must be the one picked");
  const dispatchEntry = callLog.find((e) => e.type === "dispatch");
  assert.notEqual(dispatchEntry, undefined, "dispatch must be invoked for the plain ready issue");
  assert.equal(dispatchEntry.issue.number, 11, "dispatch must receive the plain ready issue");
});

test("cronASelect: DEFERS a ready issue whose declared deps are not all merged (relabel ready->queued, NOT dispatched)", () => {
  const callLog = makeCallLog();
  const runLock = makeFakeRunLock(callLog);
  const gh = makeFakeGh(callLog, {
    issues: [{ number: 20, labels: ["harness:ready"], createdAt: "2024-01-01T00:00:00Z", body: "```harness-deps\n#12\n```" }],
    mergedDeps: new Set(), // #12 not merged
  });
  const dispatch = makeFakeDispatch(callLog);

  const result = cronASelect(baseOpts({ runLock, gh, dispatch }));

  const deferred = callLog.find(
    (e) => e.type === "gh" && e.args[0] === "issue" && e.args[1] === "edit" && e.args[2] === "20" && e.args.includes("--add-label") && e.args.includes("harness:queued") && e.args.includes("--remove-label") && e.args.includes("harness:ready")
  );
  assert.ok(deferred, "the ready issue with an unmerged dependency must be relabeled ready->queued");
  const dispatched = callLog.find((e) => e.type === "dispatch");
  assert.equal(dispatched, undefined, "an issue with unmerged deps must NEVER be dispatched");
  assert.equal(result.dispatched, false, "no dispatchable issue this fire");
  assert.equal(runLock.releaseCalls.length, 1, "the lock must be released when nothing is dispatched");
});

test("cronASelect: ensures the harness:queued label exists BEFORE the first defer relabel", () => {
  const callLog = makeCallLog();
  const runLock = makeFakeRunLock(callLog);
  const gh = makeFakeGh(callLog, {
    issues: [{ number: 21, labels: ["harness:ready"], createdAt: "2024-01-01T00:00:00Z", body: "```harness-deps\n#99\n```" }],
  });
  cronASelect(baseOpts({ runLock, gh, dispatch: makeFakeDispatch(callLog) }));

  const ensureIdx = callLog.findIndex((e) => e.type === "gh" && e.args[0] === "label" && e.args[1] === "create" && e.args[2] === "harness:queued" && e.args.includes("--force"));
  const deferIdx = callLog.findIndex((e) => e.type === "gh" && e.args[0] === "issue" && e.args[1] === "edit" && e.args[2] === "21" && e.args.includes("harness:queued"));
  assert.notEqual(ensureIdx, -1, "harness:queued label-create must be invoked");
  assert.ok(ensureIdx < deferIdx, "the label-create must run before the first defer relabel");
});

test("cronASelect: DISPATCHES a ready issue once ALL its declared deps are merged", () => {
  const callLog = makeCallLog();
  const runLock = makeFakeRunLock(callLog);
  const gh = makeFakeGh(callLog, {
    issues: [{ number: 22, labels: ["harness:ready"], createdAt: "2024-01-01T00:00:00Z", body: "```harness-deps\n#12\n#13\n```" }],
    mergedDeps: new Set([12, 13]),
  });
  const dispatch = makeFakeDispatch(callLog);

  const result = cronASelect(baseOpts({ runLock, gh, dispatch }));

  assert.equal(result.dispatched, true, "an issue whose deps are all merged must be dispatched");
  const dispatchEntry = callLog.find((e) => e.type === "dispatch");
  assert.equal(dispatchEntry.issue.number, 22, "dispatch must receive the dep-satisfied issue");
  const toInProgress = callLog.find((e) => e.type === "gh" && e.args[0] === "issue" && e.args[1] === "edit" && e.args[2] === "22" && e.args.includes("harness:in-progress"));
  assert.ok(toInProgress, "the dispatched issue must be relabeled ready->in-progress");
});

test("cronASelect: DEFERS a dep-unsatisfied older issue and dispatches a dep-free younger one instead", () => {
  const callLog = makeCallLog();
  const runLock = makeFakeRunLock(callLog);
  const gh = makeFakeGh(callLog, {
    issues: [
      { number: 30, labels: ["harness:ready"], createdAt: "2024-01-01T00:00:00Z", body: "```harness-deps\n#12\n```" }, // older, deps unmerged
      { number: 31, labels: ["harness:ready"], createdAt: "2024-02-01T00:00:00Z", body: "no deps" }, // younger, dep-free
    ],
    mergedDeps: new Set(), // #12 not merged
  });
  const dispatch = makeFakeDispatch(callLog);

  const result = cronASelect(baseOpts({ runLock, gh, dispatch }));

  const deferred30 = callLog.find((e) => e.type === "gh" && e.args[0] === "issue" && e.args[1] === "edit" && e.args[2] === "30" && e.args.includes("harness:queued"));
  assert.ok(deferred30, "the older dep-unsatisfied issue must be deferred to queued");
  assert.equal(result.dispatched, true, "a dispatchable younger issue must still be dispatched this fire");
  assert.equal(callLog.find((e) => e.type === "dispatch").issue.number, 31, "dispatch must receive the dep-free issue #31");
});
