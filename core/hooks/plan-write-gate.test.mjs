/**
 * @description Test suite for plan-write-gate.mjs — PreToolUse(Write|Edit) hook.
 * Drives decide() and processInput() directly (no subprocess spawn).
 * Run with: node --test core/hooks/plan-write-gate.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

import { decide, processInput, checkPlanContent } from "./plan-write-gate.mjs";

const SETTINGS_PATH = fileURLToPath(new URL("../settings.json", import.meta.url));

/**
 * Builds a minimal PreToolUse Write/Edit payload.
 * @param {string} toolName - 'Write' or 'Edit'
 * @param {string} filePath - the tool_input.file_path
 * @param {object} [extra] - extra top-level fields (e.g. { agent_id, agent_type })
 */
function makeWritePayload(toolName, filePath, extra = {}) {
  return {
    session_id: "ses_x",
    tool_name: toolName,
    tool_input: { file_path: filePath },
    ...extra,
  };
}

const PLAN_PATH = ".claude/plans/x/execution-plan.json";

// --- content cancela (model_strategy furo) ---
const VALID_MS = '{"model_strategy":{"hand_tiers":{"low":"qwen3-coder-next","medium":"glm-5.2","high":"kimi-k2.7-code"},"planner":"opus"}}';
const LEGACY_MS = '{"model_strategy":{"tiers":{"low":"haiku","medium":"sonnet","high":"opus"}}}';

test("checkPlanContent: legacy Claude `tiers` shape → deny reason", () => {
  assert.match(checkPlanContent(LEGACY_MS), /legacy Claude `tiers`/);
});
test("checkPlanContent: valid hand_tiers → null (accept)", () => {
  assert.equal(checkPlanContent(VALID_MS), null);
});
test("checkPlanContent: hand_tiers missing → deny reason", () => {
  assert.match(checkPlanContent('{"model_strategy":{"planner":"opus"}}'), /hand_tiers is required/);
});
test("checkPlanContent: invalid JSON in a Write → deny reason (positive invalid signal)", () => {
  assert.match(checkPlanContent("{not json"), /not valid JSON/);
});
test("checkPlanContent: non-string content (Edit/anomalous) → null (fail open)", () => {
  assert.equal(checkPlanContent(undefined), null);
});
test("decide: planner Write with legacy tiers content → deny", () => {
  const payload = { session_id: "s", tool_name: "Write", tool_input: { file_path: PLAN_PATH, content: LEGACY_MS }, agent_id: "ag", agent_type: "planner" };
  const v = decide(payload);
  assert.equal(v.allow, false);
  assert.match(v.hookSpecificOutput.permissionDecisionReason, /legacy Claude `tiers`/);
});
test("decide: planner Write with valid hand_tiers content → allow", () => {
  const payload = { session_id: "s", tool_name: "Write", tool_input: { file_path: PLAN_PATH, content: VALID_MS }, agent_id: "ag", agent_type: "planner" };
  assert.equal(decide(payload).allow, true);
});

// LOCKED TEST 1 — main-loop Write to a plan path (no agent_id) → deny naming the rule
test("Write to plan path with no agent_id → deny naming planner-only rule", () => {
  const verdict = decide(makeWritePayload("Write", PLAN_PATH));
  assert.equal(verdict.allow, false);
  assert.equal(verdict.hookSpecificOutput.permissionDecision, "deny");
  assert.match(verdict.hookSpecificOutput.permissionDecisionReason, /planner/i);
});

// LOCKED TEST 2 — subagent planner writing the plan → allow, no hookSpecificOutput
test("Write to plan path with agent_id + agent_type planner → allow", () => {
  const verdict = decide(
    makeWritePayload("Write", PLAN_PATH, { agent_id: "ag_1", agent_type: "planner" })
  );
  assert.equal(verdict.allow, true);
  assert.equal(verdict.hookSpecificOutput, undefined);
});

// LOCKED TEST 3 — a non-planner subagent (executor) writing the plan → deny
test("Write to plan path with agent_id + agent_type executor → deny", () => {
  const verdict = decide(
    makeWritePayload("Write", PLAN_PATH, { agent_id: "ag_2", agent_type: "executor" })
  );
  assert.equal(verdict.allow, false);
  assert.equal(verdict.hookSpecificOutput.permissionDecision, "deny");
});

// LOCKED TEST 4 — a normal (non-plan) write from the main loop → allow, no gating
test("Write to a non-plan path with no agent_id → allow", () => {
  const verdict = decide(makeWritePayload("Write", "src/foo.ts"));
  assert.equal(verdict.allow, true);
  assert.equal(verdict.hookSpecificOutput, undefined);
});

// LOCKED TEST 5 — Edit (not just Write) of the plan from the main loop → deny
test("Edit of plan path with no agent_id → deny (post-review inline-edit path)", () => {
  const verdict = decide(makeWritePayload("Edit", PLAN_PATH));
  assert.equal(verdict.allow, false);
  assert.equal(verdict.hookSpecificOutput.permissionDecision, "deny");
});

// LOCKED TEST 6 — garbage stdin → fail-open
test("unparseable stdin → processInput returns {exitCode:0, output:null}", () => {
  const result = processInput("}{not json");
  assert.deepEqual(result, { exitCode: 0, output: null });
});

// LOCKED TEST 7 — namespaced agent_type 'harness:planner' normalizes to planner → allow
test("Write to plan path with agent_type 'harness:planner' → allow (bareRole)", () => {
  const verdict = decide(
    makeWritePayload("Write", PLAN_PATH, { agent_id: "ag_3", agent_type: "harness:planner" })
  );
  assert.equal(verdict.allow, true);
  assert.equal(verdict.hookSpecificOutput, undefined);
});

// LOCKED TEST 8 — settings.json wires the Write|Edit matcher, Agent+Bash still present
test("settings.json: Write|Edit matcher wires plan-write-gate.mjs; Agent+Bash intact", () => {
  const settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8"));
  const pre = settings?.hooks?.PreToolUse;
  assert.ok(Array.isArray(pre), "hooks.PreToolUse must be an array");
  const matchers = pre.map((e) => e.matcher);
  assert.ok(matchers.includes("Agent"), "Agent matcher must still be present");
  assert.ok(matchers.includes("Bash"), "Bash matcher must still be present");
  const planEntry = pre.find((e) => e.matcher === "Write|Edit");
  assert.ok(planEntry, "a 'Write|Edit' matcher must exist");
  const cmds = planEntry.hooks.map((h) => h.command).join(" ");
  assert.match(cmds, /plan-write-gate\.mjs/);
});

// ADVERSARIAL — path-variant bypass: '..' traversal landing back under .claude/plans must gate
test("adversarial: '..'-variant path normalizing back under .claude/plans → deny", () => {
  const variant = ".claude/plans/x/../y/execution-plan.json";
  const verdict = decide(makeWritePayload("Write", variant));
  assert.equal(verdict.allow, false);
  assert.equal(verdict.hookSpecificOutput.permissionDecision, "deny");
});

// ADVERSARIAL — '..' escaping OUT of .claude/plans must NOT gate (not a plan write)
test("adversarial: '..'-variant path escaping out of plans dir → allow", () => {
  const escaped = ".claude/plans/x/../../src/execution-plan.json";
  const verdict = decide(makeWritePayload("Write", escaped));
  assert.equal(verdict.allow, true);
});

// ADVERSARIAL — namespaced NON-planner role must not pass the planner check
test("adversarial: agent_type 'harness:executor' on plan path → deny", () => {
  const verdict = decide(
    makeWritePayload("Write", PLAN_PATH, { agent_id: "ag_4", agent_type: "harness:executor" })
  );
  assert.equal(verdict.allow, false);
  assert.equal(verdict.hookSpecificOutput.permissionDecision, "deny");
});

// adversary Finding 2 — case-insensitive FS: a case-variant plan path must still gate
test("Finding 2: 'Execution-Plan.json' case variant (no agent_id) → deny", () => {
  const verdict = decide(makeWritePayload("Write", ".claude/plans/x/Execution-Plan.json"));
  assert.equal(verdict.allow, false);
  assert.equal(verdict.hookSpecificOutput.permissionDecision, "deny");
});

test("Finding 2: '.Claude/plans' dir-case variant (no agent_id) → deny", () => {
  const verdict = decide(makeWritePayload("Write", ".Claude/plans/x/execution-plan.json"));
  assert.equal(verdict.allow, false);
  assert.equal(verdict.hookSpecificOutput.permissionDecision, "deny");
});

// adversary Finding 3 — gate-state/triage files are hooks-only: NO tool write, not even planner
test("Finding 3: Write gate-state.json from main loop → deny (hooks-only)", () => {
  const verdict = decide(
    makeWritePayload("Write", ".claude/plans/.state/ses_x/gate-state.json")
  );
  assert.equal(verdict.allow, false);
  assert.equal(verdict.hookSpecificOutput.permissionDecision, "deny");
});

test("Finding 3: Edit triage.json even as planner subagent → deny (state is hooks-only)", () => {
  const verdict = decide(
    makeWritePayload("Edit", ".claude/plans/.state/ses_x/triage.json", {
      agent_id: "ag_p",
      agent_type: "planner",
    })
  );
  assert.equal(verdict.allow, false);
  assert.equal(verdict.hookSpecificOutput.permissionDecision, "deny");
});

// non-regression: a normal write is still never gated
test("Finding 3: a normal non-state, non-plan write still passes", () => {
  const verdict = decide(makeWritePayload("Write", "src/foo.ts"));
  assert.equal(verdict.allow, true);
  assert.equal(verdict.hookSpecificOutput, undefined);
});
