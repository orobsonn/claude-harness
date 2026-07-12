/**
 * @description Locked hermetic tests for parseOcRunLog (T12 NDJSON session oracle).
 * No network, no real opencode. Exit code is never success.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  parseOcRunLog,
  OC_RUN_OUTCOME,
  OC_RUN_OUTCOME_VALUES,
} from "./oc-run-outcome.mjs";

function ndjson(events) {
  return events.map((e) => JSON.stringify(e)).join("\n");
}

function toolUseError(message, extra = {}) {
  return {
    type: "tool_use",
    part: {
      state: {
        status: "error",
        error: message,
      },
    },
    ...extra,
  };
}

function stepFinish(extra = {}) {
  return {
    type: "step_finish",
    tokens: { input: 1, output: 1 },
    cost: 0,
    ...extra,
  };
}

// ---- locked: deny-but-exit-0 → tool_deny ----

test("locked: tool_use error with [entry-gate] returns tool_deny even when processExitCode is 0", () => {
  const log = ndjson([
    { type: "step_start" },
    toolUseError("[entry-gate] dual required before task"),
    { type: "text", text: "GATE_PROBE_DONE" },
    stepFinish(),
  ]);
  const result = parseOcRunLog(log, { processExitCode: 0 });
  assert.equal(result.ok, false);
  assert.equal(result.outcome, OC_RUN_OUTCOME.TOOL_DENY);
  assert.equal(result.outcome, "tool_deny");
  assert.equal(result.processExitCode, 0);
});

// ---- locked: mixed non-JSON + tool error → tool_deny, never throw ----

test("locked: mixed log with non-JSON lines plus one valid tool_use error returns tool_deny and does not throw", () => {
  const log = [
    "loading plugins...",
    "not json at all",
    JSON.stringify(toolUseError("[plan-gate] missing dual status")),
    "trailing noise",
  ].join("\n");

  let threw = false;
  let result;
  try {
    result = parseOcRunLog(log, { processExitCode: 0 });
  } catch {
    threw = true;
  }
  assert.equal(threw, false);
  assert.ok(result);
  assert.equal(result.ok, false);
  assert.equal(result.outcome, "tool_deny");
  assert.ok(result.eventCounts.noise >= 2);
});

// ---- locked: empty → empty, ok false ----

test("locked: empty string returns outcome empty and ok false", () => {
  const result = parseOcRunLog("");
  assert.equal(result.ok, false);
  assert.equal(result.outcome, OC_RUN_OUTCOME.EMPTY);
  assert.equal(result.outcome, "empty");
});

// ---- locked: exit 0 never success when tool_use error present ----

test("locked: never treats processExitCode 0 alone as success when any tool_use error is present", () => {
  // Non-gate tool error still fails ceremony even with exit 0
  const log = ndjson([
    toolUseError("bash failed: command not found"),
    stepFinish(),
  ]);
  const result = parseOcRunLog(log, { processExitCode: 0 });
  assert.equal(result.ok, false);
  assert.notEqual(result.outcome, "ok");
  assert.equal(result.outcome, OC_RUN_OUTCOME.CEREMONY_FAILED);

  // Gate deny also not ok
  const deny = parseOcRunLog(
    ndjson([toolUseError("[loop-guard] max iterations")]),
    { processExitCode: 0 }
  );
  assert.equal(deny.ok, false);
  assert.equal(deny.outcome, "tool_deny");
});

// ---- locked: clean step_finish → ok ----

test("locked: clean step_finish without tool error returns ok true and outcome ok", () => {
  const log = ndjson([
    { type: "step_start" },
    { type: "text", text: "all good" },
    stepFinish(),
  ]);
  const result = parseOcRunLog(log, { processExitCode: 0 });
  assert.equal(result.ok, true);
  assert.equal(result.outcome, OC_RUN_OUTCOME.OK);
  assert.equal(result.outcome, "ok");
});

// ---- locked: malformed-only → parse_error, never throws ----

test("locked: malformed-only NDJSON returns outcome parse_error and never throws", () => {
  const log = "{\n{not valid json\n{\"type\":\n";
  let threw = false;
  let result;
  try {
    result = parseOcRunLog(log);
  } catch {
    threw = true;
  }
  assert.equal(threw, false);
  assert.ok(result);
  assert.equal(result.ok, false);
  assert.equal(result.outcome, OC_RUN_OUTCOME.PARSE_ERROR);
  assert.equal(result.outcome, "parse_error");
});

// ---- supporting: closed enum, incomplete, never-throw on garbage ----

test("closed outcome enum matches ok|tool_deny|ceremony_failed|incomplete|empty|parse_error", () => {
  assert.deepEqual(
    [...OC_RUN_OUTCOME_VALUES].sort(),
    ["ceremony_failed", "empty", "incomplete", "ok", "parse_error", "tool_deny"].sort()
  );
});

test("truncated mid-stream without step_finish returns incomplete", () => {
  const log = ndjson([
    { type: "step_start" },
    { type: "tool_use", part: { state: { status: "running" } } },
  ]);
  const result = parseOcRunLog(log);
  assert.equal(result.ok, false);
  assert.equal(result.outcome, "incomplete");
});

test("type error event without tool_use still ceremony_failed", () => {
  const log = ndjson([
    { type: "error", message: "provider blew up" },
  ]);
  const result = parseOcRunLog(log, { processExitCode: 1 });
  assert.equal(result.ok, false);
  assert.equal(result.outcome, "ceremony_failed");
});

test("never-throw: null/undefined/number/object inputs", () => {
  for (const input of [null, undefined, 42, { not: "a string" }, ["arr"]]) {
    let threw = false;
    let result;
    try {
      result = parseOcRunLog(/** @type {any} */ (input));
    } catch {
      threw = true;
    }
    assert.equal(threw, false, `threw on ${String(input)}`);
    assert.ok(result);
    assert.equal(typeof result.ok, "boolean");
    assert.ok(OC_RUN_OUTCOME_VALUES.has(result.outcome));
  }
});

test("hallucinated success text after tool deny is still tool_deny", () => {
  const log = ndjson([
    toolUseError("[entry-gate] blocked"),
    { type: "text", text: "Status: DONE — all criteria met" },
    stepFinish(),
  ]);
  const result = parseOcRunLog(log, { processExitCode: 0 });
  assert.equal(result.ok, false);
  assert.equal(result.outcome, "tool_deny");
});

test("non-JSON-only noise returns empty not parse_error", () => {
  const result = parseOcRunLog("hello world\nloading...\n");
  assert.equal(result.ok, false);
  assert.equal(result.outcome, "empty");
});

test("processExitCode alone with empty log is never ok", () => {
  const result = parseOcRunLog("", { processExitCode: 0 });
  assert.equal(result.ok, false);
  assert.equal(result.outcome, "empty");
});
