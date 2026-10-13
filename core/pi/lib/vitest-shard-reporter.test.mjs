import assert from "node:assert/strict";
import test from "node:test";
import Reporter from "./vitest-shard-reporter.mjs";

test("retry/expected-failure updates do not trigger cancellation before the final result", () => {
  const reporter = new Reporter();
  const failures = [];
  reporter.notifyFailure = (errors) => failures.push(errors);
  reporter.onInit({ state: { idMap: new Map([["test", { type: "test" }]]) } });
  reporter.onTaskUpdate([["test", { state: "fail", errors: ["retry"] }]]);
  reporter.onTaskUpdate([["test", { state: "run", retryCount: 1 }]]);
  reporter.onTaskUpdate([["test", { state: "pass", duration: 5 }]]);
  assert.equal(failures.length, 0);
  reporter.onTaskUpdate([["test", { state: "fail", duration: 5, errors: ["final"] }]]);
  assert.deepEqual(failures, [["final"]]);
});

test("suite hook failures are reported immediately and unhandled errors also fail", () => {
  const reporter = new Reporter();
  const failures = [];
  reporter.notifyFailure = (errors) => failures.push(errors);
  reporter.onInit({ state: { idMap: new Map([["suite", { type: "suite" }]]) } });
  reporter.onTaskUpdate([["suite", { state: "fail", errors: ["beforeAll"] }]]);
  reporter.onFinished([], ["unhandled"]);
  assert.deepEqual(failures, [["beforeAll"], ["unhandled"]]);
});

test("diagnostics are printed once before the failure notification", () => {
  const reporter = new Reporter();
  const printed = [];
  reporter.onInit({ logger: { printError: (error) => printed.push(error) } });
  reporter.notifyFailure(["original error"]);
  reporter.notifyFailure(["duplicate"]);
  assert.deepEqual(printed, ["original error"]);
});
