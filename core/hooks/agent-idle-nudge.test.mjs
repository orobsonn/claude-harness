/**
 * @description Test suite for agent-idle-nudge.mjs — PostToolUse[Agent] hook.
 *
 * ## Assumed API (the hand must match this exactly)
 *
 * ### `decide(payload, env, deps)`
 *   Pure. No I/O. Never throws. Returns `{action:'inject', context}` | `{action:'none'}`.
 *   Qualifying idle transition (all must hold):
 *     - `payload` is an object with a present `tool_input` object      (well-formed dispatch)
 *     - `payload.tool_name === 'Agent'`
 *     - `payload.agent_id` absent                                     (main-loop only; presence = nested)
 *     - idle ONLY when BOTH `payload.tool_response` AND `payload.tool_output` are idle —
 *       a field is idle when it is null/undefined OR a string that trims to ''         (no report text)
 *   Any non-string non-null field value (number, boolean, object, array) is a report (NOT idle),
 *   so an empty-string tool_response does not mask a real report delivered in tool_output.
 *   On inject: `context` (a single string) contains BOTH a single-nudge directive (send
 *   exactly one SendMessage re-prompt to extract the report) AND a fallback/no-loop
 *   directive (if still no report, record unresolved, do not loop / re-dispatch).
 *
 * ### `processInput(rawStr, deps)`
 *   Parses `rawStr`, calls `decide`. Returns `{ exitCode: 0, output: string|null }`.
 *   - `output`: JSON `{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"..."}}`
 *     when inject.
 *   - `output`: `null` when none.
 *   - Any thrown error / malformed JSON → `{ exitCode: 0, output: null }`.
 *
 * ## Testing strategy
 *   - All tests use **dynamic import** (`await import(...)`) so that each test fails
 *     individually (RED) when the module does not yet exist, rather than failing the
 *     entire file at load time.
 *   - `env` is always `{}` or omitted — no real env var is read by any test.
 *
 * Run with: node --test core/hooks/agent-idle-nudge.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

// Module URL used for dynamic import, resolved relative to this test file.
const MODULE_URL = new URL("./agent-idle-nudge.mjs", import.meta.url);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Builds a minimal main-loop Agent dispatch payload (no agent_id). */
function mainLoopAgentPayload(extra = {}) {
  return {
    tool_name: "Agent",
    tool_input: { subagent_type: "compliance", prompt: "run the compliance eye" },
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Test 1 — happy path: empty tool_response => inject, context has single-nudge directive
// ---------------------------------------------------------------------------

test(
  "decide: main-loop Agent payload with tool_response:'' => action 'inject', context has " +
    "single-nudge (send exactly one SendMessage re-prompt) directive",
  async () => {
    const { decide } = await import(MODULE_URL);

    const payload = mainLoopAgentPayload({ tool_response: "" });
    const res = decide(payload, {});

    assert.equal(res.action, "inject");
    assert.match(res.context, /nudge/i);
    assert.match(res.context, /once|one|exactly one/i);
    assert.match(res.context, /SendMessage/i);
  },
);

// ---------------------------------------------------------------------------
// Test 2 — whitespace-only tool_response trims to empty => inject
// ---------------------------------------------------------------------------

test(
  "decide: main-loop Agent payload with tool_response:'   ' (whitespace-only) => action 'inject' " +
    "(whitespace trims to empty => idle)",
  async () => {
    const { decide } = await import(MODULE_URL);

    const payload = mainLoopAgentPayload({ tool_response: "   " });
    const res = decide(payload, {});

    assert.equal(res.action, "inject");
  },
);

// ---------------------------------------------------------------------------
// Test 3 — both tool_response and tool_output absent => inject
// ---------------------------------------------------------------------------

test(
  "decide: main-loop Agent payload with NO tool_response and NO tool_output (both absent) => " +
    "action 'inject' (absent report => idle)",
  async () => {
    const { decide } = await import(MODULE_URL);

    const payload = mainLoopAgentPayload();
    delete payload.tool_response;
    delete payload.tool_output;
    const res = decide(payload, {});

    assert.equal(res.action, "inject");
  },
);

// ---------------------------------------------------------------------------
// Test 4 — the same context ALSO contains the unresolved/no-loop fallback directive
// ---------------------------------------------------------------------------

test(
  "decide: the injected context from an idle payload ALSO contains the unresolved/no-loop " +
    "fallback directive (record unresolved, do not re-dispatch)",
  async () => {
    const { decide } = await import(MODULE_URL);

    const payload = mainLoopAgentPayload({ tool_response: "" });
    const res = decide(payload, {});

    assert.equal(res.action, "inject");
    assert.match(res.context, /unresolved/i);
    assert.match(res.context, /(do not|don't|no).{0,20}loop|not re-?dispatch/i);
  },
);

// ---------------------------------------------------------------------------
// Test 5 — agent_id present => none (main-loop only)
// ---------------------------------------------------------------------------

test(
  "decide: otherwise-idle payload but agent_id truthy => action 'none' (main-loop only, " +
    "skip inside subagent)",
  async () => {
    const { decide } = await import(MODULE_URL);

    const payload = mainLoopAgentPayload({ agent_id: "abc", tool_response: "" });
    const res = decide(payload, {});

    assert.equal(res.action, "none");
  },
);

// ---------------------------------------------------------------------------
// Test 6 — tool_name !== 'Agent' => none
// ---------------------------------------------------------------------------

test(
  "decide: tool_name='SendMessage' (not 'Agent') with empty tool_response => action 'none'",
  async () => {
    const { decide } = await import(MODULE_URL);

    const payload = {
      tool_name: "SendMessage",
      tool_input: { subagent_type: "compliance", prompt: "..." },
      tool_response: "",
    };
    const res = decide(payload, {});

    assert.equal(res.action, "none");
  },
);

// ---------------------------------------------------------------------------
// Test 7 — non-empty report string => none
// ---------------------------------------------------------------------------

test(
  "decide: main-loop Agent payload with a non-empty report string => action 'none'",
  async () => {
    const { decide } = await import(MODULE_URL);

    const payload = mainLoopAgentPayload({ tool_response: "Here is my report..." });
    const res = decide(payload, {});

    assert.equal(res.action, "none");
  },
);

// ---------------------------------------------------------------------------
// Test 8 — non-null structured object report => none
// ---------------------------------------------------------------------------

test(
  "decide: main-loop Agent payload with tool_response:{} (non-null object) => action 'none' " +
    "(structured object counts as a report)",
  async () => {
    const { decide } = await import(MODULE_URL);

    const payload = mainLoopAgentPayload({ tool_response: {} });
    const res = decide(payload, {});

    assert.equal(res.action, "none");
  },
);

// ---------------------------------------------------------------------------
// Test 9 — malformed payloads: null and missing tool_input => none, never throws
// ---------------------------------------------------------------------------

test(
  "decide: null payload and payload missing tool_input => action 'none' without throwing",
  async () => {
    const { decide } = await import(MODULE_URL);

    let r1;
    let r2;
    assert.doesNotThrow(() => {
      r1 = decide(null, {});
    });
    assert.doesNotThrow(() => {
      r2 = decide({ tool_name: "Agent" }, {});
    });

    assert.equal(r1.action, "none");
    assert.equal(r2.action, "none");
  },
);

// ---------------------------------------------------------------------------
// Test 10 — processInput with invalid JSON => exit 0, output null
// ---------------------------------------------------------------------------

test(
  "processInput: invalid JSON stdin => { exitCode: 0, output: null }",
  async () => {
    const { processInput } = await import(MODULE_URL);

    const res = processInput("{ not valid json", {});

    assert.deepEqual(res, { exitCode: 0, output: null });
  },
);

// ---------------------------------------------------------------------------
// Test 11 — processInput with a qualifying idle payload => injected additionalContext
// ---------------------------------------------------------------------------

test(
  "processInput: qualifying idle Agent payload => exitCode 0 and hookSpecificOutput deep-equals " +
    "{hookEventName:'PostToolUse', additionalContext: <context from decide>}",
  async () => {
    const { decide, processInput } = await import(MODULE_URL);

    const idlePayload = mainLoopAgentPayload({ tool_response: "" });
    const expected = decide(idlePayload, {});

    const res = processInput(JSON.stringify(idlePayload), {});

    assert.equal(res.exitCode, 0);
    const parsed = JSON.parse(res.output);
    assert.deepEqual(parsed.hookSpecificOutput, {
      hookEventName: "PostToolUse",
      additionalContext: expected.context,
    });
  },
);

// ---------------------------------------------------------------------------
// Test 12 — falsy-but-present agent_id ('') is a nested dispatch => none (F1)
// ---------------------------------------------------------------------------

test(
  "falsy-but-present agent_id ('') is a nested dispatch => none (presence-check, not truthiness)",
  async () => {
    const { decide } = await import(MODULE_URL);

    const payload = {
      tool_name: "Agent",
      tool_input: { subagent_type: "compliance" },
      agent_id: "",
      tool_response: "",
    };
    const res = decide(payload, {});

    assert.equal(res.action, "none");
  },
);

// ---------------------------------------------------------------------------
// Test 13 — falsy-but-present agent_id (0) is a nested dispatch => none (F1)
// ---------------------------------------------------------------------------

test(
  "falsy-but-present agent_id (0) is a nested dispatch => none",
  async () => {
    const { decide } = await import(MODULE_URL);

    const payload = {
      tool_name: "Agent",
      tool_input: {},
      agent_id: 0,
      tool_response: "",
    };
    const res = decide(payload, {});

    assert.equal(res.action, "none");
  },
);

// ---------------------------------------------------------------------------
// Test 14 — empty tool_response but a real report in tool_output => none (F2)
// ---------------------------------------------------------------------------

test(
  "empty tool_response but a real report in tool_output => none (report delivered, not idle)",
  async () => {
    const { decide } = await import(MODULE_URL);

    const payload = {
      tool_name: "Agent",
      tool_input: {},
      tool_response: "",
      tool_output: "Here is my full structured report.",
    };
    const res = decide(payload, {});

    assert.equal(res.action, "none");
  },
);
