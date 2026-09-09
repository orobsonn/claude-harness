import assert from "node:assert/strict";
import test from "node:test";

import { findShadowedCanonicalRoles, piDispatchRoute, validateSubagentDispatch } from "./dispatch-rail.mjs";

const INDEPENDENT_REVIEW_ROUTES = Object.freeze({
  "harness-adversary": { model: "openai-codex/gpt-5.6-sol", thinking: "medium" },
  "harness-discussion-adversary": { model: "openai-codex/gpt-5.6-sol", thinking: "medium" },
  "harness-plan-reviewer": { model: "openai-codex/gpt-6-astra", thinking: "high" },
  "harness-test-reviewer": { model: "openai-codex/gpt-5.6-luna", thinking: "xhigh" },
  "harness-compliance": { model: "openai-codex/gpt-5.6-terra", thinking: "high" },
  "harness-security": { model: "openai-codex/gpt-5.6-sol" },
});

test("dispatch admits only canonical foreground roles within the finite 144-turn cap", () => {
  assert.deepEqual(
    validateSubagentDispatch({ subagent_type: "harness-planner", max_turns: 144, model: "openai-codex/gpt-5.6-sol", thinking: "high" }),
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
    validateSubagentDispatch({ subagent_type: "harness-planner", max_turns: 145 }),
    { ok: false, reason: "turn-limit" },
  );
  assert.deepEqual(
    validateSubagentDispatch({ subagent_type: "harness-planner", resume: "stale-child", model: "openai-codex/gpt-5.6-sol", thinking: "high" }),
    { ok: false, reason: "resume-disabled" },
  );
});

test("all three reviewers require a fresh dispatch and cannot resume or run in the background", () => {
  for (const subagent_type of ["harness-adversary", "harness-compliance", "harness-security"]) {
    assert.deepEqual(validateSubagentDispatch({ subagent_type, resume: "old-child" }), { ok: false, reason: "resume-disabled" });
    assert.deepEqual(validateSubagentDispatch({ subagent_type, run_in_background: true }), { ok: false, reason: "background-disabled" });
  }
});

test("rotas de modelo do Pi são fixas por papel e por complexidade da mão", () => {
  assert.deepEqual(piDispatchRoute("harness-discussion-adversary"), {
    ok: true, model: "openai-codex/gpt-5.6-sol", thinking: "medium",
  });
  assert.deepEqual(piDispatchRoute("harness-plan-reviewer"), {
    ok: true, model: "openai-codex/gpt-6-astra", thinking: "high",
  });
  assert.deepEqual(piDispatchRoute("harness-planner"), {
    ok: true, model: "openai-codex/gpt-5.6-sol", thinking: "high",
  });
  assert.deepEqual(piDispatchRoute("harness-test-author"), {
    ok: true, model: "openai-codex/gpt-5.6-terra", thinking: "high",
  });
  assert.deepEqual(piDispatchRoute("harness-test-reviewer"), {
    ok: true, model: "openai-codex/gpt-5.6-luna", thinking: "xhigh",
  });
  assert.deepEqual(piDispatchRoute("harness-executor", "low"), {
    ok: true, model: "openai-codex/gpt-5.6-luna", thinking: "high",
  });
  assert.deepEqual(piDispatchRoute("harness-sniper", "medium"), {
    ok: true, model: "openai-codex/gpt-5.6-terra", thinking: "medium",
  });
  assert.deepEqual(piDispatchRoute("harness-executor", "high"), {
    ok: true, model: "openai-codex/gpt-5.6-terra", thinking: "xhigh",
  });
  assert.deepEqual(piDispatchRoute("harness-sniper", "max"), {
    ok: true, model: "openai-codex/gpt-5.6-terra", thinking: "xhigh",
  });

  assert.deepEqual(
    validateSubagentDispatch({ subagent_type: "harness-compliance", model: "openai-codex/gpt-5.6-terra", thinking: "high" }),
    { ok: true },
  );
  assert.deepEqual(
    validateSubagentDispatch({ subagent_type: "harness-test-reviewer", model: "openai-codex/gpt-5.6-luna", thinking: "xhigh" }),
    { ok: true },
  );
  assert.deepEqual(
    validateSubagentDispatch({ subagent_type: "harness-test-reviewer", model: "openai-codex/gpt-5.6-terra", thinking: "high" }),
    { ok: false, reason: "model-route" },
  );
  assert.deepEqual(
    validateSubagentDispatch({ subagent_type: "harness-compliance", model: "openai-codex/gpt-5.6-luna", thinking: "xhigh" }),
    { ok: false, reason: "model-route" },
  );
  assert.deepEqual(
    validateSubagentDispatch({ subagent_type: "harness-plan-reviewer", model: "openai-codex/gpt-6-astra", thinking: "high" }),
    { ok: true },
  );
  assert.deepEqual(
    validateSubagentDispatch({ subagent_type: "harness-plan-reviewer", model: "openai-codex/gpt-5.6-sol", thinking: "high" }),
    { ok: false, reason: "model-route" },
  );
  assert.deepEqual(
    validateSubagentDispatch({ subagent_type: "harness-discussion-adversary", model: "openai-codex/gpt-6-astra", thinking: "medium" }),
    { ok: false, reason: "model-route" },
  );
  assert.deepEqual(
    validateSubagentDispatch({ subagent_type: "harness-executor", complexity: "low", model: "openai-codex/gpt-5.6-terra", thinking: "high" }),
    { ok: false, reason: "model-route" },
  );
  assert.deepEqual(
    validateSubagentDispatch({ subagent_type: "harness-security", model: "openai-codex/gpt-5.6-sol", thinking: "medium" }),
    { ok: false, reason: "model-route" },
  );
});

test("dispatch rejects a role shadowed by the issue project", () => {
  const shadowedRoles = new Set(["harness-adversary"]);
  assert.deepEqual(
    validateSubagentDispatch({ subagent_type: "harness-adversary", model: "openai-codex/gpt-5.6-sol", thinking: "medium" }, { shadowedRoles }),
    { ok: false, reason: "shadowed-role" },
  );
  assert.deepEqual(
    validateSubagentDispatch({ subagent_type: "harness-planner", model: "openai-codex/gpt-5.6-sol", thinking: "high" }, { shadowedRoles }),
    { ok: true },
  );
});

test("independent reviewers reject inherited conversation context, including malformed truthy input", () => {
  for (const [subagent_type, route] of Object.entries(INDEPENDENT_REVIEW_ROUTES)) {
    assert.deepEqual(
      validateSubagentDispatch({ subagent_type, ...route, inherit_context: false }),
      { ok: true },
      `${subagent_type} must accept an explicit fresh-context dispatch`,
    );
    assert.deepEqual(
      validateSubagentDispatch({ subagent_type, ...route, inherit_context: true }),
      { ok: false, reason: "context-inheritance-disabled" },
      `${subagent_type} must reject boolean context inheritance`,
    );
    assert.deepEqual(
      validateSubagentDispatch({ subagent_type, ...route, inherit_context: "true" }),
      { ok: false, reason: "context-inheritance-disabled" },
      `${subagent_type} must reject malformed values that the subagent runtime treats as truthy`,
    );
  }
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
