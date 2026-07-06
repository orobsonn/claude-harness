/**
 * @description Pinned contract tests for cron-a-select.mjs's `--json` field list on the
 * `gh issue list` call. The picked issue must carry its `title` end-to-end — from the `--json`
 * fields requested from `gh`, through the eligible/picked issue object, to the object handed off
 * to the dispatch seam (cron-a-dispatch, task-5) — so a human skimming dispatched-issue metadata
 * (e.g. a notification, a log line) sees the issue's title, not just its number.
 *
 * Every seam cronASelect needs — the run-lock acquire/release, `gh`, and cron-a-dispatch itself —
 * is INJECTED as a fake so these tests are fully hermetic: no real git/gh/tmux/process is ever
 * spawned. Fakes mirror the shape used in cron-a-select.test.mjs (a shared callLog array recording
 * every seam invocation).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { cronASelect } from "./cron-a-select.mjs";

/** @description Fresh shared ordered call log every seam fake below pushes entries into. */
function makeCallLog() {
  return [];
}

/**
 * @description Fake run-lock seam. acquire() always reports a fresh acquired lock; release() is a
 * no-op recorder. Both push into the shared callLog for parity with the sibling suite's shape.
 */
function makeFakeRunLock(callLog) {
  return {
    acquire(opts) {
      callLog.push({ type: "lock-acquire", opts });
      return { acquired: true, acquireTs: 4242 };
    },
    release(opts) {
      callLog.push({ type: "lock-release", opts });
    },
  };
}

/**
 * @description Fake `gh` seam. Records every invocation into the shared callLog as
 * `{ type: "gh", args }`. Answers `gh issue list` with the injected `issues` set; every other
 * invocation (label create, issue edit) returns `{ ok: true }`.
 */
function makeFakeGh(callLog, { issues = [] } = {}) {
  function gh(args) {
    callLog.push({ type: "gh", args });
    if (args[0] === "issue" && args[1] === "list") {
      return issues;
    }
    return { ok: true };
  }
  return gh;
}

/**
 * @description Fake cron-a-dispatch (task-5) seam. Records its (issue, lock) args into the shared
 * callLog as `{ type: "dispatch", issue, lock }`.
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
  stateDir = "/tmp/cron-a-select-title-fixture-state",
  runLock,
  gh,
  dispatch,
}) {
  return { project, stateDir, runLock, gh, dispatch };
}

test("cronASelect: the `gh issue list` call's --json field list includes `title` (alongside number, labels, createdAt, body)", () => {
  const callLog = makeCallLog();
  const runLock = makeFakeRunLock(callLog);
  const gh = makeFakeGh(callLog, {
    issues: [{ number: 141, title: "fix billing race", labels: ["harness:ready"] }],
  });
  const dispatch = makeFakeDispatch(callLog);

  cronASelect(baseOpts({ runLock, gh, dispatch }));

  const listCall = callLog.find(
    (e) => e.type === "gh" && e.args[0] === "issue" && e.args[1] === "list"
  );
  assert.notEqual(listCall, undefined, "cronASelect must call `gh issue list`");
  const jsonIdx = listCall.args.indexOf("--json");
  assert.notEqual(jsonIdx, -1, "the issue-list call must pass a --json flag");
  const jsonFields = listCall.args[jsonIdx + 1].split(",");
  assert.ok(
    jsonFields.includes("title"),
    "the gh issue list --json fields must include `title` so the picked issue carries its title"
  );
  assert.ok(jsonFields.includes("number"), "the --json fields must still include `number`");
  assert.ok(jsonFields.includes("labels"), "the --json fields must still include `labels`");
  assert.ok(jsonFields.includes("createdAt"), "the --json fields must still include `createdAt`");
  assert.ok(jsonFields.includes("body"), "the --json fields must still include `body`");
});

test("cronASelect: the issue handed to the dispatch seam carries its `title` from the eligible gh-returned issue", () => {
  const callLog = makeCallLog();
  const runLock = makeFakeRunLock(callLog);
  const gh = makeFakeGh(callLog, {
    issues: [{ number: 141, title: "fix billing race", labels: ["harness:ready"] }],
  });
  const dispatch = makeFakeDispatch(callLog);

  cronASelect(baseOpts({ runLock, gh, dispatch }));

  const dispatchEntry = callLog.find((e) => e.type === "dispatch");
  assert.notEqual(dispatchEntry, undefined, "dispatch must be invoked for the eligible issue");
  assert.equal(
    dispatchEntry.issue.number,
    141,
    "dispatch must receive the eligible issue (141)"
  );
  assert.equal(
    dispatchEntry.issue.title,
    "fix billing race",
    "the issue object handed to dispatch must carry its title === 'fix billing race'"
  );
});
