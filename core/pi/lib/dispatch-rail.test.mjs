import assert from "node:assert/strict";
import test from "node:test";

import { findShadowedCanonicalRoles, validateSubagentDispatch } from "./dispatch-rail.mjs";

test("dispatch admits only canonical foreground roles within the turn cap", () => {
  assert.deepEqual(
    validateSubagentDispatch({ subagent_type: "harness-planner", max_turns: 16 }),
    { ok: true },
  );
  assert.deepEqual(
    validateSubagentDispatch({ subagent_type: "planner" }),
    { ok: false, reason: "unknown-role" },
  );
  assert.deepEqual(
    validateSubagentDispatch({ subagent_type: "harness-planner", run_in_background: true }),
    { ok: false, reason: "background-disabled" },
  );
  assert.deepEqual(
    validateSubagentDispatch({ subagent_type: "harness-planner", max_turns: 17 }),
    { ok: false, reason: "turn-limit" },
  );
});

test("dispatch rejects a role shadowed by the issue project", () => {
  const shadowedRoles = new Set(["harness-adversary"]);
  assert.deepEqual(
    validateSubagentDispatch({ subagent_type: "harness-adversary" }, { shadowedRoles }),
    { ok: false, reason: "shadowed-role" },
  );
  assert.deepEqual(
    validateSubagentDispatch({ subagent_type: "harness-planner" }, { shadowedRoles }),
    { ok: true },
  );
});

test("project role scan identifies only canonical shadow files", () => {
  const present = new Set([
    "/issue/.pi/agents/harness-planner.md",
    "/issue/.pi/agents/ordinary.md",
    "/issue/.pi/agents/harness-executor.txt",
  ]);
  assert.deepEqual(
    [...findShadowedCanonicalRoles("/issue", (path) => present.has(path))],
    ["harness-planner"],
  );
});
