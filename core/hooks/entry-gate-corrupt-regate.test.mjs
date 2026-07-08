/**
 * @description LOCKED TESTS — corrupt regate_pending handling.
 * Transcribes 9 pinned assertions for the entry-gate re-gate rail's behavior
 * when gate-state.regate_pending is not an array (corrupted/malformed value),
 * plus the classifyRegatePending() helper contract.
 * Run with: node --test core/hooks/entry-gate-corrupt-regate.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, classifyRegatePending } from "./entry-gate.mjs";

/**
 * Builds a minimal PreToolUse Bash payload.
 * @param {string} sessionId
 * @param {string} command
 * @param {object} [extra] - extra top-level fields
 */
function makeBashPayload(sessionId, command, extra = {}) {
  return { session_id: sessionId, tool_name: "Bash", tool_input: { command }, ...extra };
}

/**
 * Builds a minimal PreToolUse Agent payload.
 * @param {string} sessionId
 * @param {string} subagentType
 * @param {object} [extra] - extra top-level fields
 */
function makeAgentPayload(sessionId, subagentType, extra = {}) {
  return { session_id: sessionId, tool_name: "Agent", tool_input: { subagent_type: subagentType }, ...extra };
}

// ---------------------------------------------------------------------------
// LOCKED TEST 1
// Given gate-state with regate_pending as a corrupt string ('BROKEN'),
// When a PreToolUse(Bash) 'git push origin main' payload is decided,
// Then deny with a reason naming both the corruption and the raw value.
// ---------------------------------------------------------------------------

test("LOCKED 1: Bash corrupt-string regate_pending → deny naming 'gate-state corrupted' and the raw value", () => {
  const readGateStateFn = () => ({ regate_pending: "BROKEN" });
  const payload = makeBashPayload("ses_corrupt_1", "git push origin main");

  const verdict = decide(payload, { readGateStateFn });

  assert.equal(verdict.allow, false, "corrupt regate_pending must deny the delivery command");
  assert.equal(verdict.hookSpecificOutput.permissionDecision, "deny");
  const reason = verdict.hookSpecificOutput.permissionDecisionReason;
  assert.ok(reason.includes("gate-state corrupted"), `reason must include "gate-state corrupted" — got: "${reason}"`);
  assert.ok(reason.includes("BROKEN"), `reason must include the raw value "BROKEN" — got: "${reason}"`);
});

// ---------------------------------------------------------------------------
// LOCKED TEST 2
// Given gate-state with regate_pending as a corrupt object,
// When a shipper Agent payload is decided (with triage satisfying Gate 1),
// Then deny naming 'gate-state corrupted' and instructing to repair/delete
// gate-state.json — distinct from the normal "stamp regate-passed" advice.
// ---------------------------------------------------------------------------

test("LOCKED 2: Shipper corrupt-object regate_pending → deny with distinct repair instruction (not 'stamp regate-passed')", () => {
  const readGateStateFn = () => ({ regate_pending: { foo: 1 } });
  const readTriage = () => ({ mode: "LIGHT", feature_id: "feat" });
  const payload = makeAgentPayload("ses_corrupt_2", "shipper");

  const verdict = decide(payload, { readGateStateFn, readTriage });

  assert.equal(verdict.allow, false, "corrupt regate_pending must deny the shipper");
  assert.equal(verdict.hookSpecificOutput.permissionDecision, "deny");
  const reason = verdict.hookSpecificOutput.permissionDecisionReason;
  assert.ok(reason.includes("gate-state corrupted"), `reason must include "gate-state corrupted" — got: "${reason}"`);
  assert.ok(reason.includes("gate-state.json"), `reason must mention repairing/deleting gate-state.json — got: "${reason}"`);
  assert.ok(
    !reason.includes("regate-passed"),
    `reason must NOT tell the operator to stamp regate-passed (that is the normal-path advice) — got: "${reason}"`,
  );
});

// ---------------------------------------------------------------------------
// LOCKED TEST 3
// Given classifyRegatePending({ regate_pending: <non-array value> }),
// When called for each of null, 'x', 5, { a: 1 },
// Then it returns { corrupt: true, raw: <same value> } for each.
// ---------------------------------------------------------------------------

test("LOCKED 3: classifyRegatePending classifies non-array values (null, string, number, object) as corrupt with the raw value preserved", () => {
  const values = [null, "x", 5, { a: 1 }];

  for (const value of values) {
    const result = classifyRegatePending({ regate_pending: value });
    assert.equal(result.corrupt, true, `value ${JSON.stringify(value)} must be classified as corrupt`);
    assert.strictEqual(result.raw, value, `raw must strictly equal the original value ${JSON.stringify(value)}`);
  }
});

// ---------------------------------------------------------------------------
// LOCKED TEST 4
// Given gate-state that reads as {} (absent regate_pending / infra fail-open),
// When a Bash 'git push origin main' payload is decided,
// Then allow.
// ---------------------------------------------------------------------------

test("LOCKED 4: Bash with absent regate_pending (infra/absent) → allow (fail-open)", () => {
  const readGateStateFn = () => ({});
  const payload = makeBashPayload("ses_corrupt_4", "git push origin main");

  const verdict = decide(payload, { readGateStateFn });

  assert.equal(verdict.allow, true, "absent regate_pending must fail-open to allow");
});

// ---------------------------------------------------------------------------
// LOCKED TEST 5
// Given the pre-existing valid-array regate_pending behavior (unmatched deny,
// matched allow), When decided via Bash 'git push origin main', Then that
// behavior is preserved exactly as before the corrupt-value handling.
// ---------------------------------------------------------------------------

test("LOCKED 5: Bash valid-array regate_pending behavior preserved (unmatched deny naming task-1, matched allow)", () => {
  const readGateStateFnUnmatched = () => ({ regate_pending: ["task-1"] });
  const payloadUnmatched = makeBashPayload("ses_corrupt_5a", "git push origin main");
  const verdictUnmatched = decide(payloadUnmatched, { readGateStateFn: readGateStateFnUnmatched });

  assert.equal(verdictUnmatched.allow, false, "unmatched regate_pending must still deny");
  assert.ok(
    verdictUnmatched.hookSpecificOutput.permissionDecisionReason.includes("task-1"),
    `deny reason must name the unmatched task — got: "${verdictUnmatched.hookSpecificOutput.permissionDecisionReason}"`,
  );

  const readGateStateFnMatched = () => ({ regate_pending: ["task-1"], regate_passed: ["task-1"] });
  const payloadMatched = makeBashPayload("ses_corrupt_5b", "git push origin main");
  const verdictMatched = decide(payloadMatched, { readGateStateFn: readGateStateFnMatched });

  assert.equal(verdictMatched.allow, true, "matched regate_pending must still allow");
});

// ---------------------------------------------------------------------------
// LOCKED TEST 6
// Given classifyRegatePending() called on an absent regate_pending and on a
// valid array, Then it returns { corrupt: false, pending: [...] } in both cases.
// ---------------------------------------------------------------------------

test("LOCKED 6: classifyRegatePending on absent and valid-array regate_pending → corrupt:false, pending array", () => {
  assert.deepEqual(classifyRegatePending({}), { corrupt: false, pending: [] });
  assert.deepEqual(classifyRegatePending({ regate_pending: ["a", "b"] }), {
    corrupt: false,
    pending: ["a", "b"],
  });
});

// ---------------------------------------------------------------------------
// LOCKED TEST 7
// Given a corrupt regate_pending raw value, When decided, Then the raw value
// is logged to stderr (console.error) for operator diagnosis.
// ---------------------------------------------------------------------------

test("LOCKED 7: corrupt regate_pending raw value is logged to stderr via console.error", () => {
  const originalConsoleError = console.error;
  const calls = [];
  console.error = (...args) => {
    calls.push(args.map(String).join(" "));
  };

  try {
    const readGateStateFn = () => ({ regate_pending: "LOUD_RAW_VALUE" });
    const payload = makeBashPayload("ses_corrupt_7", "git push origin main");
    decide(payload, { readGateStateFn });
  } finally {
    console.error = originalConsoleError;
  }

  assert.ok(
    calls.some((call) => call.includes("LOUD_RAW_VALUE")),
    `at least one console.error call must include the raw corrupt value — got: ${JSON.stringify(calls)}`,
  );
});

// ---------------------------------------------------------------------------
// LOCKED TEST 8
// Given gate-state that reads as {} (absent regate_pending / infra fail-open),
// When a shipper Agent payload is decided (with triage satisfying Gate 1),
// Then allow.
// ---------------------------------------------------------------------------

test("LOCKED 8: Shipper with absent regate_pending (infra/absent) → allow (fail-open)", () => {
  const readGateStateFn = () => ({});
  const readTriage = () => ({ mode: "LIGHT", feature_id: "feat" });
  const payload = makeAgentPayload("ses_corrupt_8", "shipper");

  const verdict = decide(payload, { readGateStateFn, readTriage });

  assert.equal(verdict.allow, true, "absent regate_pending must fail-open to allow the shipper");
});

// ---------------------------------------------------------------------------
// LOCKED TEST 9
// Given a corrupt regate_pending raw value that is very large (5000 chars),
// When decided, Then deny, but the permissionDecisionReason must be truncated
// (must not contain the full 5000-char blob nor a run longer than 200 chars).
// ---------------------------------------------------------------------------

test("LOCKED 9: corrupt regate_pending raw value is truncated in the deny reason (cap 200)", () => {
  const big = "X".repeat(5000);
  const readGateStateFn = () => ({ regate_pending: big });
  const payload = makeBashPayload("ses_corrupt_9", "git push origin main");

  const verdict = decide(payload, { readGateStateFn });

  assert.equal(verdict.allow, false);
  assert.equal(verdict.hookSpecificOutput.permissionDecision, "deny");
  const reason = verdict.hookSpecificOutput.permissionDecisionReason;
  assert.ok(!reason.includes(big), "deny reason must not include the full 5000-char blob");
  assert.ok(!reason.includes("X".repeat(201)), "deny reason must not include a run of more than 200 consecutive 'X' characters");
});
