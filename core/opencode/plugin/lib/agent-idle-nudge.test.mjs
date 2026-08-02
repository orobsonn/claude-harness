/**
 * @description Pins the contract for pure module `./agent-idle-nudge.mjs` exporting `decide(payload, env?, deps?)`.
 * OC main-loop idle nudge for Task/agent family (parity with CC agent-idle-nudge decide semantics,
 * adapted per design: OC-native context wording, task-family tool names, presence-check on three agent keys,
 * distinct tool_response/tool_output idle detection, no SendMessage requirement).
 *
 * All tests use dynamic import so each fails individually (RED) when the module does not yet exist.
 *
 * ## Assumed decide contract (pinned by these tests)
 * - Returns `{action: 'inject', context: string}` or `{action: 'none'}`
 * - Main-loop only: absence of agent_id/agentId/agentID keys (use hasOwn / presence, not truthy)
 * - Task family: tool_name === 'task' || === 'agent' || endsWith .task or .agent (case-insens)
 * - Idle only when BOTH tool_response and tool_output are idle (absent / null / undefined / trim==='')
 * - Any non-string non-null value (e.g. object {}) counts as report → none
 * - Never throws on malformed (null, missing tool_input, etc.)
 * - On inject: context non-empty, contains nudge/re-prompt/report language, does not mention SendMessage
 */

import test from "node:test";
import assert from "node:assert/strict";

// Module URL used for dynamic import, resolved relative to this test file.
const MODULE_URL = new URL("./agent-idle-nudge.mjs", import.meta.url);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Builds a minimal main-loop Task/agent-family dispatch payload (no agent_* keys). */
function mainLoopTaskPayload(extra = {}) {
  return {
    tool_name: "task",
    tool_input: { subagent_type: "compliance", prompt: "run the compliance eye" },
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// lt-idle-main-loop-inject
// ---------------------------------------------------------------------------

test(
  "lt-idle-main-loop-inject: main-loop Task/agent payload WITHOUT agent_id|agentId|agentID keys, " +
    "both tool_response and tool_output idle ('' or absent) → `decide` returns `{action:'inject', context}` " +
    "where context is non-empty string matching /nudge|re-prompt|report/i and does NOT require SendMessage",
  async () => {
    const { decide } = await import(MODULE_URL);

    const payload = mainLoopTaskPayload({ tool_response: "", tool_output: "" });
    const res = decide(payload, {});

    assert.equal(res.action, "inject");
    assert.ok(typeof res.context === "string" && res.context.length > 0);
    assert.match(res.context, /nudge|re-prompt|report/i);
    assert.doesNotMatch(res.context, /SendMessage/i);
  },
);

// ---------------------------------------------------------------------------
// lt-idle-nested-agent-id-none
// ---------------------------------------------------------------------------

test(
  "lt-idle-nested-agent-id-none: agent_id present including falsy `''`, `0`, `null` → action none",
  async () => {
    const { decide } = await import(MODULE_URL);

    const cases = ["sub-123", "", 0, null];
    for (const v of cases) {
      const payload = mainLoopTaskPayload({ agent_id: v, tool_response: "" });
      const res = decide(payload);
      assert.equal(res.action, "none", `for agent_id=${JSON.stringify(v)}`);
    }
  },
);

// ---------------------------------------------------------------------------
// lt-idle-nested-agentId-agentID-none
// ---------------------------------------------------------------------------

test(
  "lt-idle-nested-agentId-agentID-none: agentId or agentID key present (incl falsy) → none",
  async () => {
    const { decide } = await import(MODULE_URL);

    const extras = [
      { agentId: "x" },
      { agentId: "" },
      { agentID: 0 },
      { agentID: null },
      { agentId: false },
    ];
    for (const extra of extras) {
      const payload = mainLoopTaskPayload({ ...extra, tool_response: "" });
      const res = decide(payload);
      assert.equal(res.action, "none");
    }
  },
);

// ---------------------------------------------------------------------------
// lt-idle-report-or-partial-output-none
// ---------------------------------------------------------------------------

test(
  "lt-idle-report-or-partial-output-none: non-empty tool_response → none; empty tool_response + real tool_output string → none",
  async () => {
    const { decide } = await import(MODULE_URL);

    // non-empty tool_response is a report
    let payload = mainLoopTaskPayload({ tool_response: "Here is the completed work." });
    let res = decide(payload);
    assert.equal(res.action, "none");

    // empty response but real output string counts as report
    payload = mainLoopTaskPayload({
      tool_response: "",
      tool_output: "full structured report delivered via tool_output",
    });
    res = decide(payload);
    assert.equal(res.action, "none");
  },
);

test("provider capacity exhaustion injects the executor escalation instruction instead of ending the loop", async () => {
  const { decide } = await import(MODULE_URL);
  const result = decide(mainLoopTaskPayload({ tool_input: { subagent_type: "executor-medium" }, tool_response: "Maximum steps reached" }));
  assert.equal(result.action, "inject");
  assert.match(result.context, /capacity|tier|escalat/i);
});

// ---------------------------------------------------------------------------
// lt-idle-malformed-none
// ---------------------------------------------------------------------------

test(
  "lt-idle-malformed-none: null payload and missing tool_input → none, never throws",
  async () => {
    const { decide } = await import(MODULE_URL);

    let r1;
    let r2;
    assert.doesNotThrow(() => {
      r1 = decide(null, {});
    });
    assert.doesNotThrow(() => {
      r2 = decide({ tool_name: "task" }, {});
    });

    assert.equal(r1 && r1.action, "none");
    assert.equal(r2 && r2.action, "none");
  },
);

// ---------------------------------------------------------------------------
// lt-idle-non-task-tool-none
// ---------------------------------------------------------------------------

test(
  "lt-idle-non-task-tool-none: tool_name 'bash' or 'read' with idle fields → none",
  async () => {
    const { decide } = await import(MODULE_URL);

    for (const tn of ["bash", "read", "grep", "write"]) {
      const payload = {
        tool_name: tn,
        tool_input: {},
        tool_response: "",
        tool_output: "",
      };
      const res = decide(payload);
      assert.equal(res.action, "none", `tool_name=${tn} must be none`);
    }
  },
);

// ---------------------------------------------------------------------------
// Additional pins from contract
// ---------------------------------------------------------------------------

test(
  "tool_name 'task' or 'agent' or 'foo.task' qualifies as task family when other conditions hold (main-loop idle → inject)",
  async () => {
    const { decide } = await import(MODULE_URL);

    for (const tn of ["task", "agent", "foo.task", "bar.agent", "Task", "AGENT", "my.agent"]) {
      const payload = { tool_name: tn, tool_input: { prompt: "x" }, tool_response: "" };
      const res = decide(payload);
      assert.equal(res.action, "inject", `tool_name=${tn}`);
    }
  },
);

test(
  "whitespace-only tool_response + absent tool_output → inject",
  async () => {
    const { decide } = await import(MODULE_URL);

    const payload = mainLoopTaskPayload({ tool_response: "   \t \n " });
    delete payload.tool_output;
    const res = decide(payload);
    assert.equal(res.action, "inject");
  },
);

test(
  "tool_response:{} object → none (structured report)",
  async () => {
    const { decide } = await import(MODULE_URL);

    const payload = mainLoopTaskPayload({ tool_response: {} });
    const res = decide(payload);
    assert.equal(res.action, "none");
  },
);
