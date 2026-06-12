/**
 * @description Test suite for entry-gate.mjs — PreToolUse(Agent) hook.
 * Tests drive decide() and processInput() directly (no subprocess spawn).
 * File-system tests use withTempDir() for isolation.
 * Run with: node --test core/hooks/entry-gate.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { decide, processInput } from "./entry-gate.mjs";

const ENTRY_GATE_PATH = fileURLToPath(new URL("./entry-gate.mjs", import.meta.url));

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Runs fn inside a fresh OS tmpdir (chdir'd to it), then restores cwd and removes the dir.
 * gate-lib uses relative paths resolved from cwd, so chdir isolation prevents polluting
 * the repo's .claude/plans/ during tests.
 * @param {() => void} fn - Synchronous test body
 */
function withTempDir(fn) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "entry-gate-test-"));
  const savedCwd = process.cwd();
  try {
    process.chdir(tmpDir);
    fn();
  } finally {
    process.chdir(savedCwd);
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore cleanup errors */
    }
  }
}

/**
 * Builds a minimal PreToolUse Agent payload.
 * @param {string} sessionId
 * @param {string} subagentType
 * @param {object} [extra] - extra fields (e.g. { agent_id: 'ag_1' })
 */
function makeAgentPayload(sessionId, subagentType, extra = {}) {
  return {
    session_id: sessionId,
    tool_name: "Agent",
    tool_input: { subagent_type: subagentType },
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// LOCKED TEST 1
// Given a main-loop Agent payload (no agent_id) with subagent_type 'executor' and
// NO triage.json for the session, When decide runs, Then it returns a deny whose
// hookSpecificOutput.permissionDecision is 'deny' and whose reason names triaging-requests
// ---------------------------------------------------------------------------

test(
  "Gate 1: executor with no triage.json → deny naming triaging-requests",
  () => {
    const payload = makeAgentPayload("ses_gate1_exec", "executor");
    const readTriage = () => null; // no triage.json

    const verdict = decide(payload, { readTriage });

    assert.equal(verdict.allow, false, "should be denied");
    assert.equal(
      verdict.hookSpecificOutput.permissionDecision,
      "deny",
      "permissionDecision must be 'deny'",
    );
    assert.ok(
      verdict.hookSpecificOutput.permissionDecisionReason.includes("triaging-requests"),
      `reason must name triaging-requests — got: "${verdict.hookSpecificOutput.permissionDecisionReason}"`,
    );
  },
);

// ---------------------------------------------------------------------------
// LOCKED TEST 2
// Given subagent_type 'general-purpose' (non-delivery) and no triage.json,
// When decide runs, Then it returns allow (no deny emitted)
// ---------------------------------------------------------------------------

test(
  "non-delivery role general-purpose → allow (no deny emitted)",
  () => {
    const payload = makeAgentPayload("ses_nondel", "general-purpose");
    const readTriage = () => null; // triage.json absent — irrelevant for non-delivery

    const verdict = decide(payload, { readTriage });

    assert.equal(verdict.allow, true, "non-delivery role must always be allowed");
  },
);

// ---------------------------------------------------------------------------
// LOCKED TEST 3
// Given subagent_type 'executor' but the payload carries agent_id 'ag_1',
// When decide runs, Then it returns allow (subagent context, no state pollution)
// ---------------------------------------------------------------------------

test(
  "agent_id present → allow (subagent context, no state pollution)",
  () => {
    const payload = makeAgentPayload("ses_subagent", "executor", { agent_id: "ag_1" });
    const readTriage = () => null; // irrelevant — agent_id check fires first

    const verdict = decide(payload, { readTriage });

    assert.equal(verdict.allow, true, "subagent context must be allowed unconditionally");
  },
);

// ---------------------------------------------------------------------------
// LOCKED TEST 4
// Given subagent_type 'executor' and a triage.json with mode 'FULL',
// When decide runs, Then it returns allow
// ---------------------------------------------------------------------------

test(
  "executor with triage.json mode FULL → allow",
  () => {
    const payload = makeAgentPayload("ses_exec_full", "executor");
    const readTriage = () => ({ session_id: "ses_exec_full", mode: "FULL", feature_id: "my-feature" });

    const verdict = decide(payload, { readTriage });

    assert.equal(verdict.allow, true, "executor with valid FULL triage must be allowed");
  },
);

// ---------------------------------------------------------------------------
// LOCKED TEST 5
// Given a main-loop Agent dispatch with subagent_type 'adversary' and triage.json
// present (Gate 1 passes), When decide runs, Then it returns allow AND gate-state.json
// for the session has adversary_fired set to true
// ---------------------------------------------------------------------------

test(
  "adversary dispatch: allow AND records adversary_fired in gate-state.json",
  () => {
    withTempDir(() => {
      const sessionId = "ses_adversary_record";
      const payload = makeAgentPayload(sessionId, "adversary");
      const readTriage = () => ({ session_id: sessionId, mode: "FULL", feature_id: "some-feat" });

      // Use real mergeGateState (default) via chdir'd tmpdir
      const verdict = decide(payload, { readTriage });

      assert.equal(verdict.allow, true, "adversary dispatch must be allowed");

      const gateStatePath = `.claude/plans/.state/${sessionId}/gate-state.json`;
      assert.ok(fs.existsSync(gateStatePath), "gate-state.json must exist after adversary dispatch");

      const state = JSON.parse(fs.readFileSync(gateStatePath, "utf8"));
      assert.equal(state.adversary_fired, true, "adversary_fired must be set to true");
    });
  },
);

// ---------------------------------------------------------------------------
// LOCKED TEST 6
// Given subagent_type 'planner' with triage.json present and gate-state.json having
// brainstormed=true but adversary_fired absent, When decide runs, Then it returns a deny
// whose reason names the spec-adversary
// ---------------------------------------------------------------------------

test(
  "planner: brainstormed=true but adversary_fired absent → deny naming spec-adversary",
  () => {
    const payload = makeAgentPayload("ses_plan_no_adv", "planner");
    const readTriage = () => ({ session_id: "ses_plan_no_adv", mode: "FULL", feature_id: "feat" });
    const readGateStateFn = () => ({ brainstormed: true }); // adversary_fired absent

    const verdict = decide(payload, { readTriage, readGateStateFn });

    assert.equal(verdict.allow, false, "planner must be denied without adversary_fired");
    assert.equal(verdict.hookSpecificOutput.permissionDecision, "deny");
    assert.ok(
      verdict.hookSpecificOutput.permissionDecisionReason.toLowerCase().includes("adversary"),
      `reason must name the spec-adversary — got: "${verdict.hookSpecificOutput.permissionDecisionReason}"`,
    );
  },
);

// ---------------------------------------------------------------------------
// LOCKED TEST 7
// Given subagent_type 'planner' with triage.json present and gate-state.json having
// adversary_fired=true but brainstormed absent, When decide runs, Then it returns a deny
// whose reason names brainstorming
// ---------------------------------------------------------------------------

test(
  "planner: adversary_fired=true but brainstormed absent → deny naming brainstorming",
  () => {
    const payload = makeAgentPayload("ses_plan_no_bs", "planner");
    const readTriage = () => ({ session_id: "ses_plan_no_bs", mode: "FULL", feature_id: "feat" });
    const readGateStateFn = () => ({ adversary_fired: true }); // brainstormed absent

    const verdict = decide(payload, { readTriage, readGateStateFn });

    assert.equal(verdict.allow, false, "planner must be denied without brainstormed");
    assert.equal(verdict.hookSpecificOutput.permissionDecision, "deny");
    assert.ok(
      verdict.hookSpecificOutput.permissionDecisionReason.toLowerCase().includes("brainstorm"),
      `reason must name brainstorming — got: "${verdict.hookSpecificOutput.permissionDecisionReason}"`,
    );
  },
);

// ---------------------------------------------------------------------------
// LOCKED TEST 8
// Given triage.json with mode 'LIGHT', gate-state.json missing adversary_fired,
// and subagent_type 'planner', When decide runs, Then it returns deny
// (Gate 2 applies in LIGHT too, not only FULL)
// ---------------------------------------------------------------------------

test(
  "planner with mode LIGHT and missing adversary_fired → deny (Gate 2 applies in LIGHT too)",
  () => {
    const payload = makeAgentPayload("ses_plan_light", "planner");
    const readTriage = () => ({ session_id: "ses_plan_light", mode: "LIGHT", feature_id: "feat" });
    const readGateStateFn = () => ({}); // neither brainstormed nor adversary_fired

    const verdict = decide(payload, { readTriage, readGateStateFn });

    assert.equal(verdict.allow, false, "Gate 2 must apply in LIGHT mode too");
    assert.equal(verdict.hookSpecificOutput.permissionDecision, "deny");
  },
);

// ---------------------------------------------------------------------------
// LOCKED TEST 9
// Given subagent_type 'planner' with triage.json present and gate-state.json having
// BOTH brainstormed=true and adversary_fired=true, When decide runs, Then it returns allow
// ---------------------------------------------------------------------------

test(
  "planner: both brainstormed=true AND adversary_fired=true → allow",
  () => {
    const payload = makeAgentPayload("ses_plan_ok", "planner");
    const readTriage = () => ({ session_id: "ses_plan_ok", mode: "FULL", feature_id: "feat" });
    const readGateStateFn = () => ({ brainstormed: true, adversary_fired: true });

    const verdict = decide(payload, { readTriage, readGateStateFn });

    assert.equal(verdict.allow, true, "planner must be allowed when both gates pass");
  },
);

// ---------------------------------------------------------------------------
// LOCKED TEST 10
// Given a malformed/unparseable payload on stdin, When entry-gate runs,
// Then it exits 0 and emits NO deny on stdout (fail-open infra)
// ---------------------------------------------------------------------------

test(
  "malformed payload on stdin: exits 0 with no deny on stdout (fail-open infra)",
  () => {
    // processInput simulates the CLI entry point without spawning a subprocess.
    // Malformed input → JSON.parse throws → fail-open: exitCode 0, no output.
    const result = processInput("not-valid-json{{{{}}}}");

    assert.equal(result.exitCode, 0, "exit code must be 0 for malformed input");
    assert.equal(result.output, null, "no deny must be emitted for malformed input (fail-open)");
  },
);

// ---------------------------------------------------------------------------
// Additional coverage — non-locked
// ---------------------------------------------------------------------------

test("decide: non-object payload (null) → allow (fail-open)", () => {
  assert.equal(decide(null).allow, true);
  assert.equal(decide(undefined).allow, true);
  assert.equal(decide("string").allow, true);
  assert.equal(decide(42).allow, true);
  assert.equal(decide([]).allow, true);
});

test("decide: executor with triage mode LIGHT → allow", () => {
  const payload = makeAgentPayload("ses_exec_light", "executor");
  const readTriage = () => ({ mode: "LIGHT", feature_id: "feat" });
  assert.equal(decide(payload, { readTriage }).allow, true);
});

test("decide: executor with triage mode QUICK → deny (Gate 1: QUICK not in {LIGHT,FULL})", () => {
  const payload = makeAgentPayload("ses_exec_quick", "executor");
  const readTriage = () => ({ mode: "QUICK", feature_id: "feat" });
  const verdict = decide(payload, { readTriage });
  assert.equal(verdict.allow, false);
  assert.equal(verdict.hookSpecificOutput.permissionDecision, "deny");
});

test("decide: executor with triage mode no-ceremony → deny (Gate 1)", () => {
  const payload = makeAgentPayload("ses_exec_nc", "executor");
  const readTriage = () => ({ mode: "no-ceremony", feature_id: "feat" });
  const verdict = decide(payload, { readTriage });
  assert.equal(verdict.allow, false);
  assert.equal(verdict.hookSpecificOutput.permissionDecision, "deny");
});

test("decide: all 9 delivery roles are gated (Gate 1 deny without triage.json)", () => {
  const deliveryRoles = [
    "planner",
    "executor",
    "compliance",
    "adversary",
    "sniper",
    "security",
    "harvester",
    "shipper",
    "plan-reviewer",
  ];
  const readTriage = () => null;
  for (const role of deliveryRoles) {
    const payload = makeAgentPayload(`ses_role_${role.replace("-", "")}`, role);
    const verdict = decide(payload, { readTriage });
    assert.equal(
      verdict.allow,
      false,
      `delivery role '${role}' must be denied without triage.json`,
    );
  }
});

test("decide: non-delivery roles pass freely even without triage.json", () => {
  const freeRoles = ["general-purpose", "Explore", "claude", "researcher", "custom-role"];
  const readTriage = () => null;
  for (const role of freeRoles) {
    const payload = makeAgentPayload("ses_free", role);
    assert.equal(decide(payload, { readTriage }).allow, true, `role '${role}' must be allowed`);
  }
});

test("decide: missing session_id → allow (infra error, fail-open)", () => {
  const payload = {
    tool_name: "Agent",
    tool_input: { subagent_type: "executor" },
    // no session_id
  };
  const readTriage = () => null;
  assert.equal(decide(payload, { readTriage }).allow, true);
});

test("decide: adversary_fired write failure never blocks (mergeGateStateFn throws)", () => {
  const payload = makeAgentPayload("ses_adv_fail", "adversary");
  const readTriage = () => ({ mode: "FULL", feature_id: "feat" });
  const mergeGateStateFn = () => { throw new Error("disk full"); };

  // Must return allow despite the write failure
  const verdict = decide(payload, { readTriage, mergeGateStateFn });
  assert.equal(verdict.allow, true, "write failure must not block adversary dispatch");
});

test("decide: planner with BOTH missing → deny reason names both brainstorming and adversary", () => {
  const payload = makeAgentPayload("ses_plan_both_missing", "planner");
  const readTriage = () => ({ mode: "FULL", feature_id: "feat" });
  const readGateStateFn = () => ({});

  const verdict = decide(payload, { readTriage, readGateStateFn });
  assert.equal(verdict.allow, false);
  // The combined-missing message names both steps
  const reason = verdict.hookSpecificOutput.permissionDecisionReason.toLowerCase();
  assert.ok(reason.includes("brainstorm"), "reason must reference brainstorming");
  assert.ok(reason.includes("adversary"), "reason must reference adversary");
});

test("processInput: valid allow payload → exitCode 0, output null", () => {
  const payload = makeAgentPayload("ses_proc_allow", "general-purpose");
  const result = processInput(JSON.stringify(payload));
  assert.equal(result.exitCode, 0);
  assert.equal(result.output, null);
});

test("processInput: valid deny payload → exitCode 0, output contains hookSpecificOutput deny", () => {
  const payload = makeAgentPayload("ses_proc_deny", "executor");
  const deps = { readTriage: () => null };
  const result = processInput(JSON.stringify(payload), deps);
  assert.equal(result.exitCode, 0);
  assert.ok(result.output !== null, "deny should produce output");
  const parsed = JSON.parse(result.output);
  assert.equal(parsed.hookSpecificOutput.permissionDecision, "deny");
});

test("processInput: empty string → exitCode 0, output null (fail-open)", () => {
  const result = processInput("");
  assert.equal(result.exitCode, 0);
  assert.equal(result.output, null);
});

// ---------------------------------------------------------------------------
// Fix 1: session_id with unsafe chars → fail-open (never brick)
// ---------------------------------------------------------------------------

test("decide: session_id '../../evil' + delivery role → allow (fail-open, not brick)", () => {
  const payload = makeAgentPayload("../../evil", "planner");
  const readTriage = () => null; // irrelevant — unsafe session_id check fires first
  const verdict = decide(payload, { readTriage });
  assert.equal(verdict.allow, true, "unsafe session_id must fail-open, never deny");
});

// ---------------------------------------------------------------------------
// Fix 3: Gate 2 deny reasons embed the real feature_id
// ---------------------------------------------------------------------------

test("decide: planner deny reason contains real feature_id from triage", () => {
  const payload = makeAgentPayload("ses_fid", "planner");
  const readTriage = () => ({ mode: "FULL", feature_id: "my-real-feature" });
  const readGateStateFn = () => ({}); // neither brainstormed nor adversary_fired

  const verdict = decide(payload, { readTriage, readGateStateFn });
  assert.equal(verdict.allow, false);
  assert.ok(
    verdict.hookSpecificOutput.permissionDecisionReason.includes("my-real-feature"),
    `deny reason must embed the real feature_id — got: "${verdict.hookSpecificOutput.permissionDecisionReason}"`,
  );
});

test("decide: planner deny (brainstorm only missing) reason contains real feature_id from triage", () => {
  const payload = makeAgentPayload("ses_fid2", "planner");
  const readTriage = () => ({ mode: "FULL", feature_id: "another-feature" });
  const readGateStateFn = () => ({ adversary_fired: true }); // brainstormed absent

  const verdict = decide(payload, { readTriage, readGateStateFn });
  assert.equal(verdict.allow, false);
  assert.ok(
    verdict.hookSpecificOutput.permissionDecisionReason.includes("another-feature"),
    `deny reason must embed the real feature_id — got: "${verdict.hookSpecificOutput.permissionDecisionReason}"`,
  );
});

// ---------------------------------------------------------------------------
// Fix 1: planner ceremony flags are bound to the feature being planned
// ---------------------------------------------------------------------------

test("decide: planner denied when gateState.feature_id !== triage.feature_id even if both flags true", () => {
  const payload = makeAgentPayload("ses_feat_mismatch", "planner");
  const readTriage = () => ({ mode: "FULL", feature_id: "feature-b" });
  // Stale state from a previous feature: both flags set, but stamped for feature-a
  const readGateStateFn = () => ({ feature_id: "feature-a", brainstormed: true, adversary_fired: true });

  const verdict = decide(payload, { readTriage, readGateStateFn });
  assert.equal(verdict.allow, false, "stale flags from another feature must not allow the planner");
  assert.equal(verdict.hookSpecificOutput.permissionDecision, "deny");
  const reason = verdict.hookSpecificOutput.permissionDecisionReason.toLowerCase();
  assert.ok(reason.includes("brainstorm") && reason.includes("adversary"),
    "deny reason must re-instruct brainstorming + spec-adversary for this feature");
});

test("decide: planner allowed when gateState.feature_id === triage.feature_id and both flags true (happy path)", () => {
  const payload = makeAgentPayload("ses_feat_match", "planner");
  const readTriage = () => ({ mode: "FULL", feature_id: "feature-a" });
  const readGateStateFn = () => ({ feature_id: "feature-a", brainstormed: true, adversary_fired: true });

  const verdict = decide(payload, { readTriage, readGateStateFn });
  assert.equal(verdict.allow, true, "matching feature_id with both flags must allow");
});

// ---------------------------------------------------------------------------
// Fix 2: namespaced delivery roles ('harness:planner', 'harness:adversary')
// ---------------------------------------------------------------------------

test("decide: 'harness:planner' is subject to Gate 2 (denied without ceremony)", () => {
  const payload = makeAgentPayload("ses_ns_planner", "harness:planner");
  const readTriage = () => ({ mode: "FULL", feature_id: "feat" });
  const readGateStateFn = () => ({});

  const verdict = decide(payload, { readTriage, readGateStateFn });
  assert.equal(verdict.allow, false, "namespaced planner must hit Gate 2");
  assert.equal(verdict.hookSpecificOutput.permissionDecision, "deny");
});

test("decide: 'harness:adversary' records adversary_fired and allows", () => {
  withTempDir(() => {
    const sessionId = "ses_ns_adversary";
    const payload = makeAgentPayload(sessionId, "harness:adversary");
    const readTriage = () => ({ mode: "FULL", feature_id: "feat" });

    const verdict = decide(payload, { readTriage }); // real mergeGateState via cwd
    assert.equal(verdict.allow, true, "namespaced adversary must be allowed");

    const state = JSON.parse(
      fs.readFileSync(`.claude/plans/.state/${sessionId}/gate-state.json`, "utf8"),
    );
    assert.equal(state.adversary_fired, true, "namespaced adversary must record adversary_fired");
  });
});

test("decide: adversary records adversary_fired without dropping pre-existing brainstormed", () => {
  withTempDir(() => {
    const sessionId = "ses_adv_nodrop";
    // Pre-write brainstormed=true into gate-state.json
    const stateDir = `.claude/plans/.state/${sessionId}`;
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, "gate-state.json"),
      JSON.stringify({ brainstormed: true }),
      "utf8",
    );

    const payload = makeAgentPayload(sessionId, "adversary");
    const readTriage = () => ({ mode: "FULL", feature_id: "feat" });

    const verdict = decide(payload, { readTriage }); // uses real mergeGateState via cwd
    assert.equal(verdict.allow, true);

    const state = JSON.parse(fs.readFileSync(path.join(stateDir, "gate-state.json"), "utf8"));
    assert.equal(state.adversary_fired, true, "adversary_fired must be set");
    assert.equal(state.brainstormed, true, "brainstormed must be retained (read-merge-write)");
  });
});

// ---------------------------------------------------------------------------
// Gate 3: shipper is the deterministic consumer of the re-gate rail
// ---------------------------------------------------------------------------

test("decide: shipper with unmatched regate_pending (no matching regate_passed) → deny", () => {
  const payload = makeAgentPayload("ses_ship_blocked", "shipper");
  const readTriage = () => ({ mode: "FULL", feature_id: "feat" });
  const readGateStateFn = () => ({ regate_pending: ["task-1"] }); // no regate_passed

  const verdict = decide(payload, { readTriage, readGateStateFn });
  assert.equal(verdict.allow, false, "shipper must be denied while a re-gate is unmatched");
  assert.equal(verdict.hookSpecificOutput.permissionDecision, "deny");
  assert.ok(
    verdict.hookSpecificOutput.permissionDecisionReason.includes("task-1"),
    `deny reason must name the unmatched task — got: "${verdict.hookSpecificOutput.permissionDecisionReason}"`,
  );
  assert.ok(
    verdict.hookSpecificOutput.permissionDecisionReason.toLowerCase().includes("re-gate"),
    "deny reason must reference the mandatory re-gate",
  );
});

test("decide: shipper with regate_pending matched by regate_passed → allow", () => {
  const payload = makeAgentPayload("ses_ship_ok", "shipper");
  const readTriage = () => ({ mode: "FULL", feature_id: "feat" });
  const readGateStateFn = () => ({ regate_pending: ["task-1"], regate_passed: ["task-1"] });

  const verdict = decide(payload, { readTriage, readGateStateFn });
  assert.equal(verdict.allow, true, "shipper must be allowed once every re-gate is matched");
});

test("decide: shipper with feature-qualified unmatched regate_pending → deny naming the qualified entry", () => {
  const payload = makeAgentPayload("ses_ship_qualified", "shipper");
  const readTriage = () => ({ mode: "FULL", feature_id: "feature-a" });
  // Two features share a bare task-1; the qualified form keeps them distinct, and the
  // unmatched computation reads whatever qualified entries the arrays carry.
  const readGateStateFn = () => ({
    regate_pending: ["feature-a/task-1", "feature-b/task-1"],
    regate_passed: ["feature-b/task-1"],
  });

  const verdict = decide(payload, { readTriage, readGateStateFn });
  assert.equal(verdict.allow, false, "shipper must be denied while feature-a/task-1 is unmatched");
  assert.ok(
    verdict.hookSpecificOutput.permissionDecisionReason.includes("feature-a/task-1"),
    "deny reason must name the qualified unmatched entry",
  );
  assert.ok(
    !verdict.hookSpecificOutput.permissionDecisionReason.includes("feature-b/task-1"),
    "the matched feature-b/task-1 must not appear as unmatched",
  );
});

test("decide: shipper with no re-gate markers at all → allow (nothing to consume)", () => {
  const payload = makeAgentPayload("ses_ship_none", "shipper");
  const readTriage = () => ({ mode: "FULL", feature_id: "feat" });
  const readGateStateFn = () => ({});

  const verdict = decide(payload, { readTriage, readGateStateFn });
  assert.equal(verdict.allow, true, "shipper without any pending re-gate must be allowed");
});

// ---------------------------------------------------------------------------
// LOCKED TESTS — delivery-bash-gate
// PreToolUse(Bash) gate: deny delivery commands when regate_pending is unmatched.
// ---------------------------------------------------------------------------

/**
 * Builds a minimal PreToolUse Bash payload.
 * @param {string} sessionId
 * @param {string} command
 * @param {object} [extra] - extra top-level fields
 */
function makeBashPayload(sessionId, command, extra = {}) {
  return {
    session_id: sessionId,
    tool_name: "Bash",
    tool_input: { command },
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// LOCKED TEST B1
// Given gate-state with an unmatched regate_pending=['task-1'],
// When a PreToolUse(Bash) payload with command 'git push origin main' is decided,
// Then permissionDecision:'deny' naming task-1.
// ---------------------------------------------------------------------------

test(
  "LOCKED B1: Bash 'git push' with unmatched regate_pending → deny naming task-1",
  () => {
    const payload = makeBashPayload("ses_bash_push_blocked", "git push origin main");
    const readGateStateFn = () => ({ regate_pending: ["task-1"] }); // no regate_passed

    const verdict = decide(payload, { readGateStateFn });

    assert.equal(verdict.allow, false, "git push must be denied while regate is unmatched");
    assert.equal(
      verdict.hookSpecificOutput.permissionDecision,
      "deny",
      "permissionDecision must be 'deny'",
    );
    assert.ok(
      verdict.hookSpecificOutput.permissionDecisionReason.includes("task-1"),
      `deny reason must name the unmatched task — got: "${verdict.hookSpecificOutput.permissionDecisionReason}"`,
    );
  },
);

// ---------------------------------------------------------------------------
// LOCKED TEST B1b
// Same scenario but with 'gh pr create' instead of 'git push'.
// ---------------------------------------------------------------------------

test(
  "LOCKED B1b: Bash 'gh pr create' with unmatched regate_pending → deny naming task-1",
  () => {
    const payload = makeBashPayload("ses_bash_pr_create_blocked", "gh pr create --title 'My PR'");
    const readGateStateFn = () => ({ regate_pending: ["task-1"] });

    const verdict = decide(payload, { readGateStateFn });

    assert.equal(verdict.allow, false, "gh pr create must be denied while regate is unmatched");
    assert.equal(verdict.hookSpecificOutput.permissionDecision, "deny");
    assert.ok(
      verdict.hookSpecificOutput.permissionDecisionReason.includes("task-1"),
      `deny reason must name the unmatched task — got: "${verdict.hookSpecificOutput.permissionDecisionReason}"`,
    );
  },
);

// ---------------------------------------------------------------------------
// LOCKED TEST B2
// Given gate-state with regate_pending=['task-1'] AND regate_passed=['task-1'] (matched),
// When a PreToolUse(Bash) payload with command 'git push origin main' is decided,
// Then allow.
// ---------------------------------------------------------------------------

test(
  "LOCKED B2: Bash 'git push' with matched regate_passed → allow",
  () => {
    const payload = makeBashPayload("ses_bash_push_ok", "git push origin main");
    const readGateStateFn = () => ({
      regate_pending: ["task-1"],
      regate_passed: ["task-1"],
    });

    const verdict = decide(payload, { readGateStateFn });

    assert.equal(verdict.allow, true, "git push must be allowed once every regate is matched");
  },
);

// ---------------------------------------------------------------------------
// LOCKED TEST B3
// Read-only commands ('git status', 'git diff') are ALWAYS allowed regardless of regate state.
// ---------------------------------------------------------------------------

test(
  "LOCKED B3: Bash read-only commands always allowed regardless of regate state",
  () => {
    const readGateStateFn = () => ({ regate_pending: ["task-1"] }); // unmatched pending
    const readOnlyCmds = ["git status", "git diff HEAD", "git log --oneline", "gh pr view 1"];

    for (const cmd of readOnlyCmds) {
      const payload = makeBashPayload("ses_bash_readonly", cmd);
      const verdict = decide(payload, { readGateStateFn });
      assert.equal(
        verdict.allow,
        true,
        `read-only command '${cmd}' must always be allowed — got deny`,
      );
    }
  },
);

// ---------------------------------------------------------------------------
// LOCKED TEST B4
// Absent/empty gate-state → allow delivery command, no throw.
// ---------------------------------------------------------------------------

test(
  "LOCKED B4: Bash delivery command with absent/empty gate-state → allow, no throw",
  () => {
    const payload = makeBashPayload("ses_bash_nostate", "git push");
    const readGateStateFn = () => ({}); // empty gate state (no regate_pending)

    let verdict;
    assert.doesNotThrow(() => {
      verdict = decide(payload, { readGateStateFn });
    }, "decide must not throw on empty gate-state");
    assert.equal(verdict.allow, true, "delivery command allowed when gate-state has no regate_pending");
  },
);

// ---------------------------------------------------------------------------
// DEFECT M — intermediate git flags before `push` must not bypass the gate
// ---------------------------------------------------------------------------

test(
  "Bash 'git -C /x push' with unmatched regate_pending → deny (intermediate -C flag does not bypass)",
  () => {
    const payload = makeBashPayload("ses_bash_C_push", "git -C /repo push origin main");
    const readGateStateFn = () => ({ regate_pending: ["my-feature/task-1"] });

    const verdict = decide(payload, { readGateStateFn });

    assert.equal(verdict.allow, false, "git -C /repo push must be gated like a bare git push");
    assert.equal(verdict.hookSpecificOutput.permissionDecision, "deny");
    assert.ok(
      verdict.hookSpecificOutput.permissionDecisionReason.includes("my-feature/task-1"),
      "deny reason must name the qualified unmatched entry",
    );
  },
);

test(
  "Bash 'git --git-dir=... --work-tree=... push' with unmatched regate_pending → deny",
  () => {
    const payload = makeBashPayload(
      "ses_bash_gitdir_push",
      "git --git-dir=/repo/.git --work-tree=/repo push",
    );
    const readGateStateFn = () => ({ regate_pending: ["feat/t1"] });
    const verdict = decide(payload, { readGateStateFn });
    assert.equal(verdict.allow, false, "git --git-dir/--work-tree push must be gated");
  },
);

test(
  "Bash 'git -C /x status' with unmatched regate_pending → allow (read-only with intermediate flag)",
  () => {
    const payload = makeBashPayload("ses_bash_C_status", "git -C /repo status");
    const readGateStateFn = () => ({ regate_pending: ["feat/t1"] });
    const verdict = decide(payload, { readGateStateFn });
    assert.equal(verdict.allow, true, "git -C /repo status is read-only and must always pass");
  },
);

// ---------------------------------------------------------------------------
// CLI integration: proves the main-guard fires end-to-end as a real CLI.
// Spawns `node entry-gate.mjs` in a temp cwd (no triage.json) feeding an
// executor payload, and asserts a deny lands on stdout — confirming main()
// runs when invoked directly (robust to path encoding/symlinks).
// ---------------------------------------------------------------------------

test("CLI: executor with no triage.json → main() runs and emits deny on stdout", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "entry-gate-cli-"));
  try {
    const payload = JSON.stringify(
      makeAgentPayload("ses_cli_exec", "executor"),
    );

    const stdout = execFileSync("node", [ENTRY_GATE_PATH], {
      input: payload,
      cwd: tmpDir,
      encoding: "utf8",
    });

    assert.ok(
      stdout.includes('"permissionDecision":"deny"'),
      `CLI stdout must contain a deny — got: "${stdout}"`,
    );
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore cleanup errors */
    }
  }
});
