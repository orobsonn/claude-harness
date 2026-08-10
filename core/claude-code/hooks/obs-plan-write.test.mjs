/**
 * @description Tests for obs-plan-write.mjs — the PostToolUse(Write) hook that emits session-side
 * spec-created / plan-created border checkpoints in real pipeline order.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { decide, processInput } from "./obs-plan-write.mjs";

const planWrite = (content) => ({
  tool_name: "Write",
  tool_input: { file_path: "/wt/.claude/plans/agent-idle-nudge/execution-plan.json", content },
});
const specWrite = () => ({
  tool_name: "Write",
  tool_input: { file_path: "/wt/.claude/plans/agent-idle-nudge/spec.md", content: "# spec" },
});

test("decide: Write of execution-plan.json → plan-created with the task count", () => {
  const d = decide(planWrite(JSON.stringify({ tasks: [1, 2, 3] })));
  assert.deepEqual(d, { action: "append", event: { type: "plan-created", tasks: 3 } });
});

test("decide: Write of spec.md → spec-created", () => {
  assert.deepEqual(decide(specWrite()), { action: "append", event: { type: "spec-created" } });
});

test("decide: unparseable / non-array plan content → plan-created WITHOUT a tasks key", () => {
  assert.deepEqual(decide(planWrite("not json")), { action: "append", event: { type: "plan-created" } });
  assert.deepEqual(decide(planWrite(JSON.stringify({ tasks: "nope" }))), {
    action: "append",
    event: { type: "plan-created" },
  });
});

test("decide: a Write to any other file → none", () => {
  assert.deepEqual(decide({ tool_name: "Write", tool_input: { file_path: "/wt/src/index.ts", content: "x" } }), {
    action: "none",
  });
});

test("decide: an Edit (not a Write) to the plan → none (a planner authors via Write)", () => {
  assert.deepEqual(decide({ tool_name: "Edit", tool_input: { file_path: "/wt/.claude/plans/f/execution-plan.json" } }), {
    action: "none",
  });
});

test("decide: a *.json under .claude/plans/.state/ is NOT a plan (gate-state) → none", () => {
  assert.deepEqual(
    decide({ tool_name: "Write", tool_input: { file_path: "/wt/.claude/plans/.state/ses/gate-state.json", content: "{}" } }),
    { action: "none" },
  );
});

test("decide: path traversal that escapes .claude/plans does not match", () => {
  assert.deepEqual(
    decide({ tool_name: "Write", tool_input: { file_path: "/wt/.claude/plans/../../etc/execution-plan.json", content: "{}" } }),
    { action: "none" },
  );
});

test("decide: null / malformed payload → none, never throws", () => {
  assert.deepEqual(decide(null), { action: "none" });
  assert.deepEqual(decide({}), { action: "none" });
});

test("processInput: preserves distinct plan task counts within one attempt", () => {
  const events = [];
  const deps = {
    env: { HARNESS_OBSERVABILITY_RUN_PATH: "/meta.json" },
    existsSync: () => true,
    readEvents: () => [...events],
    appendEvent: (_p, e) => events.push(e),
  };
  processInput(JSON.stringify(planWrite(JSON.stringify({ tasks: [1] }))), deps);
  processInput(JSON.stringify(planWrite(JSON.stringify({ tasks: [1, 2] }))), deps); // re-plan
  assert.deepEqual(events, [
    { type: "plan-created", tasks: 1 },
    { type: "plan-created", tasks: 2 },
  ], "plan-created dedupes by (type,tasks), not type alone");
});

test("processInput: a new attempt emits its own plan-created but still dedupes that attempt", () => {
  const events = [{ type: "plan-created", tasks: 1 }, { type: "attempt-started", attempt: 2 }];
  const deps = {
    env: { HARNESS_OBSERVABILITY_RUN_PATH: "/meta.json" },
    existsSync: () => true,
    readEvents: () => [...events],
    appendEvent: (_p, e) => events.push(e),
  };
  processInput(JSON.stringify(planWrite(JSON.stringify({ tasks: [1] }))), deps);
  processInput(JSON.stringify(planWrite(JSON.stringify({ tasks: [1] }))), deps);
  assert.deepEqual(events, [
    { type: "plan-created", tasks: 1 },
    { type: "attempt-started", attempt: 2 },
    { type: "plan-created", tasks: 1 },
  ]);
});

test("processInput: no HARNESS_OBSERVABILITY_RUN_PATH → no append, exit 0", () => {
  let appended = 0;
  const r = processInput(JSON.stringify(specWrite()), {
    env: {},
    existsSync: () => true,
    appendEvent: () => { appended++; },
  });
  assert.deepEqual(r, { exitCode: 0 });
  assert.equal(appended, 0);
});

test("processInput: fail-open — a throwing readEvents/appendEvent still yields exit 0", () => {
  const boom = () => { throw new Error("io"); };
  assert.doesNotThrow(() => {
    const r = processInput(JSON.stringify(planWrite("{}")), {
      env: { HARNESS_OBSERVABILITY_RUN_PATH: "/m.json" },
      existsSync: () => true,
      readEvents: boom,
      appendEvent: boom,
    });
    assert.deepEqual(r, { exitCode: 0 });
  });
});

test("processInput: invalid JSON stdin → exit 0, never throws", () => {
  assert.deepEqual(processInput("not json {", {}), { exitCode: 0 });
});
