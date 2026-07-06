/**
 * @description Frozen contract tests for the widened cronASelect eligibility filter (AC-3.1). The
 * prior filter excluded only harness:in-progress / harness:blocked / harness:in-review. An issue
 * whose PR is already shipped carries a terminal-ish label (awaiting-merge / done) or a dependency
 * hold (queued) — and if it ALSO still carries a stray harness:ready it was being re-selected and
 * re-dispatched (the #86 defect). These pin that awaiting-merge / queued / done each exclude the
 * issue from selection. Hermetic: runLock / gh / dispatch are injected fakes; no real process runs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { cronASelect } from "./cron-a-select.mjs";

function makeFakeRunLock() {
  const releaseCalls = [];
  return {
    acquire: () => ({ acquired: true, acquireTs: 4242 }),
    release: (opts) => releaseCalls.push(opts),
    releaseCalls,
  };
}

function makeFakeGh(issues) {
  const calls = [];
  function gh(args) {
    calls.push(args);
    if (args[0] === "issue" && args[1] === "list") return issues;
    return { ok: true };
  }
  return { gh, calls };
}

function makeFakeDispatch() {
  function dispatch(issue, lock) {
    dispatch.calls.push({ issue, lock });
    return { ok: true };
  }
  dispatch.calls = [];
  return dispatch;
}

/** @description Runs cronASelect against a single open harness:ready issue that ALSO carries `extra`. */
function selectWith(extraLabel) {
  const issues = [{ number: 86, labels: ["harness:ready", extraLabel], createdAt: "2026-07-06T00:00:00Z", body: "" }];
  const { gh } = makeFakeGh(issues);
  const dispatch = makeFakeDispatch();
  const result = cronASelect({
    project: "demo",
    stateDir: "/tmp/cron-a-select-automerge-fixture",
    runLock: makeFakeRunLock(),
    gh,
    dispatch,
  });
  return { result, dispatch };
}

test("AC-3.1 a harness:ready issue also carrying harness:awaiting-merge is NOT selected", () => {
  const { result, dispatch } = selectWith("harness:awaiting-merge");
  assert.equal(result.dispatched, false);
  assert.equal(dispatch.calls.length, 0);
});

test("AC-3.1 a harness:ready issue also carrying harness:queued is NOT selected", () => {
  const { result, dispatch } = selectWith("harness:queued");
  assert.equal(result.dispatched, false);
  assert.equal(dispatch.calls.length, 0);
});

test("AC-3.1 a harness:ready issue also carrying harness:done is NOT selected", () => {
  const { result, dispatch } = selectWith("harness:done");
  assert.equal(result.dispatched, false);
  assert.equal(dispatch.calls.length, 0);
});
