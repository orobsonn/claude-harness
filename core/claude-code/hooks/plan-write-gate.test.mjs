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
// The active hand family is the operator's toggle, so every content assertion states which family
// it is asserting under — a fixture that silently depended on the default would start failing the
// day the default flips, telling nobody why.
const asFamily = (family) => ({ readActiveFamily: () => ({ family, source: "config" }) });
const OLLAMA = asFamily("ollama");
const CLAUDE = asFamily("claude");
const VALID_MS = '{"model_strategy":{"hand_tiers":{"low":"gemma4","medium":"glm-5.2","high":"kimi-k2.7-code"},"planner":"opus"}}';
const VALID_CLAUDE_MS = '{"model_strategy":{"hand_tiers":{"low":"haiku","medium":"sonnet","high":"sonnet"},"planner":"opus"}}';
// The trap a membership check would wave through: three rungs, one model, zero escalation.
const FLAT_CLAUDE_MS = '{"model_strategy":{"hand_tiers":{"low":"sonnet","medium":"sonnet","high":"sonnet"},"planner":"opus"}}';
const LEGACY_MS = '{"model_strategy":{"tiers":{"low":"haiku","medium":"sonnet","high":"opus"}}}';
// #ac-1.2: an id that EXISTS in the API but is outside the approved ladder — the fixture that
// proves this rail is an allowlist, not a pointed veto of gpt-oss.
const OFF_LADDER_MS = '{"model_strategy":{"hand_tiers":{"low":"deepseek-v4-pro","medium":"glm-5.2","high":"kimi-k2.7-code"},"planner":"opus"}}';
const GPT_OSS_MS = '{"model_strategy":{"hand_tiers":{"low":"gpt-oss:20b","medium":"glm-5.2","high":"kimi-k2.7-code"},"planner":"opus"}}';

test("checkPlanContent: legacy Claude `tiers` shape → deny reason", () => {
  // Rejected by SHAPE under BOTH families: haiku/sonnet are legitimate claude rungs now, so only
  // the `tiers` key still identifies the retired form.
  assert.match(checkPlanContent(LEGACY_MS, OLLAMA), /legacy Claude `tiers`/);
  assert.match(checkPlanContent(LEGACY_MS, CLAUDE), /legacy Claude `tiers`/);
});
test("checkPlanContent: valid hand_tiers → null (accept)", () => {
  assert.equal(checkPlanContent(VALID_MS, OLLAMA), null);
});
test("checkPlanContent: the claude ladder is valid under family=claude, and the ollama one is not", () => {
  assert.equal(checkPlanContent(VALID_CLAUDE_MS, CLAUDE), null);
  const reason = checkPlanContent(VALID_MS, CLAUDE);
  assert.match(reason, /active hand family is claude/, "the deny must name the ACTIVE family");
  assert.match(reason, /hand-model-ladder\.mjs use/, "the deny must name the way to switch");
});
test("checkPlanContent: a FLAT claude ladder is refused — three rungs, one model, zero escalation", () => {
  assert.match(checkPlanContent(FLAT_CLAUDE_MS, CLAUDE), /hand_tiers\.low/);
});
test("checkPlanContent: the ollama ladder is refused under family=claude and vice versa (symmetry)", () => {
  assert.match(checkPlanContent(VALID_CLAUDE_MS, OLLAMA), /active hand family is ollama/);
});
test("checkPlanContent: an unreadable toggle is a DENY, never a silent default", () => {
  const boom = { readActiveFamily: () => { throw new Error("hands.json names an unknown hand family \"olama\""); } };
  assert.match(checkPlanContent(VALID_MS, boom), /unknown hand family/);
});
test("checkPlanContent: #ac-2.1 hand_tiers.low = gpt-oss → deny naming the tier and the refused id", () => {
  const reason = checkPlanContent(GPT_OSS_MS, OLLAMA);
  assert.match(reason, /hand_tiers\.low/, "the deny must name the offending tier");
  assert.match(reason, /gpt-oss:20b/, "the deny must name the refused id");
  assert.match(reason, /gemma4/, "the deny must name the approved ladder");
});
test("checkPlanContent: #ac-1.2 an off-ladder id that EXISTS is refused too (allowlist, not a gpt-oss veto)", () => {
  const reason = checkPlanContent(OFF_LADDER_MS, OLLAMA);
  assert.match(reason, /hand_tiers\.low/);
  assert.match(reason, /deepseek-v4-pro/);
});
test("checkPlanContent: a Claude alias in a hand tier is refused (the doc's 'escape hatch' never existed)", () => {
  assert.match(
    checkPlanContent('{"model_strategy":{"hand_tiers":{"low":"gemma4","medium":"glm-5.2","high":"opus"},"planner":"opus"}}', OLLAMA),
    /hand_tiers\.high/,
  );
});
test("checkPlanContent: #ac-2.2 the approved ladder → null (accept)", () => {
  assert.equal(checkPlanContent(VALID_MS, OLLAMA), null);
});
test("checkPlanContent: hand_tiers missing → deny reason", () => {
  assert.match(checkPlanContent('{"model_strategy":{"planner":"opus"}}', OLLAMA), /hand_tiers is required/);
});
test("checkPlanContent: invalid JSON in a Write → deny reason (positive invalid signal)", () => {
  assert.match(checkPlanContent("{not json", OLLAMA), /not valid JSON/);
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
  assert.equal(decide(payload, { readActiveFamilyFn: () => ({ family: "ollama" }) }).allow, true);
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

// --- A1 basename rail (#ac-1.1) — gate-state.json/triage.json blocked in ANY path ---

test("#ac-1.1: Write gate-state.json OUTSIDE .state/ (worktree cwd) → deny (basename rail)", () => {
  const verdict = decide(makeWritePayload("Write", "gate-state.json"));
  assert.equal(verdict.allow, false);
  assert.equal(verdict.hookSpecificOutput.permissionDecision, "deny");
});

test("#ac-1.1: Write gate-state.json to an unrelated sibling dir → deny (basename rail)", () => {
  const verdict = decide(makeWritePayload("Write", "some/other/dir/gate-state.json"));
  assert.equal(verdict.allow, false);
  assert.equal(verdict.hookSpecificOutput.permissionDecision, "deny");
});

test("#ac-1.1: Edit triage.json outside .state/ (basename anywhere) → deny", () => {
  const verdict = decide(makeWritePayload("Edit", "tmp/triage.json"));
  assert.equal(verdict.allow, false);
  assert.equal(verdict.hookSpecificOutput.permissionDecision, "deny");
});

test("#ac-1.1: basename rail is case-insensitive — Gate-State.json → deny", () => {
  const verdict = decide(makeWritePayload("Write", "Gate-State.json"));
  assert.equal(verdict.allow, false);
});

// --- A1 carve-out (#ac-1.2) — __fixtures__/*.test.* homonyms are allowed ---

test("#ac-1.2: gate-state.json under a __fixtures__/ dir → allow (test-fixture carve-out)", () => {
  const verdict = decide(
    makeWritePayload("Write", "core/hooks/__fixtures__/ses_x/gate-state.json")
  );
  assert.equal(verdict.allow, true);
  assert.equal(verdict.hookSpecificOutput, undefined);
});

test("#ac-1.2: a *.test.* segment homonym (gate-state.test.json) → allow (carve-out)", () => {
  const verdict = decide(makeWritePayload("Write", "core/hooks/gate-state.test.json"));
  assert.equal(verdict.allow, true);
});

test("#ac-1.2: carve-out also exempts a fixture under .state/ path (fixtures never reach the gate)", () => {
  const verdict = decide(
    makeWritePayload("Write", "__fixtures__/.claude/plans/.state/ses_x/gate-state.json")
  );
  assert.equal(verdict.allow, true);
});

// non-regression: a REAL .state/ gate-state.json is STILL denied (basename OR path rail)
test("#ac-1.1 non-regression: real .claude/plans/.state gate-state.json still denied", () => {
  const verdict = decide(
    makeWritePayload("Write", ".claude/plans/.state/ses_x/gate-state.json")
  );
  assert.equal(verdict.allow, false);
  assert.equal(verdict.hookSpecificOutput.permissionDecision, "deny");
});
