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

import { decide, processInput, computeGitState, adviseIssueForm } from "./entry-gate.mjs";

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
  "executor with FULL triage + ticket mapping to an on-disk FAILED record → allow",
  () => {
    // trilho-3 (Part B): a MAIN-LOOP executor escape requires (1) a stamped escalation_fallback
    // ticket AND (2) that ticket mapping to an on-disk run-record whose outcome is FAILED (the
    // non-forgeable genuine-failure evidence). Ticket + FAILED record → allow.
    const payload = makeAgentPayload("ses_exec_full", "executor");
    const readTriage = () => ({ session_id: "ses_exec_full", mode: "FULL", feature_id: "my-feature" });
    const readGateStateFn = () => ({ escalation_fallback: ["my-feature/task-1"] });
    const readHandRecordFn = (qid) => (qid === "my-feature/task-1" ? { outcome: { status: "FAILED" } } : null);

    const verdict = decide(payload, { readTriage, readGateStateFn, readHandRecordFn });

    assert.equal(verdict.allow, true, "executor with FULL triage + ticket mapping to a FAILED record must be allowed");
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

test("decide: executor with LIGHT triage + ticket mapping to an on-disk FAILED record → allow", () => {
  // trilho-3 (Part B): a ticket NAMES the task; the unlock belt is the on-disk run-record showing
  // outcome FAILED (a genuine cheap-hand run-and-fail), not the ticket alone.
  const payload = makeAgentPayload("ses_exec_light", "executor");
  const readTriage = () => ({ mode: "LIGHT", feature_id: "feat" });
  const readGateStateFn = () => ({ escalation_fallback: ["feat/task-1"] });
  const readHandRecordFn = (qid) => (qid === "feat/task-1" ? { outcome: { status: "FAILED" } } : null);
  assert.equal(decide(payload, { readTriage, readGateStateFn, readHandRecordFn }).allow, true);
});

test("decide: executor with ticket but NO on-disk record (config error) → deny", () => {
  // A pre-spawn config error writes NO run-record → the escape is denied → critical-exception path.
  const payload = makeAgentPayload("ses_exec_cfgerr", "executor");
  const readTriage = () => ({ mode: "FULL", feature_id: "feat" });
  const readGateStateFn = () => ({ escalation_fallback: ["feat/task-1"] });
  const readHandRecordFn = () => null; // no record on disk
  const verdict = decide(payload, { readTriage, readGateStateFn, readHandRecordFn });
  assert.equal(verdict.allow, false, "a ticket without a FAILED run-record must NOT unlock the Claude hand");
  assert.equal(verdict.hookSpecificOutput.permissionDecision, "deny");
});

// ---------------------------------------------------------------------------
// REWRITTEN — headless executor fidelity rail (contract updated in v0.12+)
// The old single test "headless → allow unconditionally" is split into 3 cases
// that reflect the new fidelity-rail contract:
//   (a) headless executor + fidelity_pass=[] → deny  (no longer unconditional)
//   (b) headless executor + fidelity_pass=[feat/task-1] → allow (matching feature entry)
//   (c) headless test-author and sniper → allow regardless (role-specific exemption)
// ---------------------------------------------------------------------------

test("decide: HEADLESS executor + fidelity_pass=[] → deny (fidelity rail now gates headless executor)", () => {
  // Headless executor is no longer unconditionally allowed — it requires a fidelity-pass
  // entry for the current feature so the test-author always runs first.
  const payload = makeAgentPayload("ses_exec_headless_deny", "executor");
  const readTriage = () => ({ mode: "FULL", feature_id: "feat" });
  const readGateStateFn = () => ({ fidelity_pass: [] });
  const verdict = decide(payload, { readTriage, isHeadlessFn: () => true, readGateStateFn });
  assert.equal(verdict.allow, false, "headless executor must be denied when fidelity_pass is empty");
  assert.equal(verdict.hookSpecificOutput.permissionDecision, "deny");
});

test("decide: HEADLESS executor + fidelity_pass=[feat/task-1] → allow (matching feature entry)", () => {
  // A fidelity-pass entry for the session's feature_id unlocks the headless executor.
  const payload = makeAgentPayload("ses_exec_headless_allow", "executor");
  const readTriage = () => ({ mode: "FULL", feature_id: "feat" });
  const readGateStateFn = () => ({ fidelity_pass: ["feat/task-1"] });
  const verdict = decide(payload, { readTriage, isHeadlessFn: () => true, readGateStateFn });
  assert.equal(verdict.allow, true, "headless executor must be allowed when fidelity_pass has a matching feature entry");
});

test("decide: HEADLESS test-author and sniper → allow regardless of fidelity_pass (exemption is role-specific)", () => {
  // test-author is the fidelity-pass producer — must never be blocked by its own rail.
  // sniper is the post-gate fixer — must never be blocked by the fidelity rail either.
  const readTriage = () => ({ mode: "FULL", feature_id: "feat" });
  const readGateStateFn = () => ({ fidelity_pass: [] }); // empty — would deny executor
  for (const role of ["test-author", "sniper"]) {
    const payload = makeAgentPayload(`ses_headless_${role.replace("-", "")}`, role);
    const verdict = decide(payload, { readTriage, isHeadlessFn: () => true, readGateStateFn });
    assert.equal(
      verdict.allow,
      true,
      `headless ${role} must always be allowed regardless of fidelity_pass`,
    );
  }
});

test("decide: LOCAL (not headless) hand-role Agent without evidence → still deny", () => {
  const payload = makeAgentPayload("ses_exec_local", "executor");
  const readTriage = () => ({ mode: "FULL", feature_id: "feat" });
  const verdict = decide(payload, { readTriage, isHeadlessFn: () => false });
  assert.equal(verdict.allow, false, "local hand-role Agent without a FAILED record stays denied");
});

test("decide: executor with ticket mapping to a NOT_DONE record (empty diff — genuine run) → allow", () => {
  // A NOT_DONE run (the hand spawned but produced an empty diff) is a genuine run failure — a
  // stronger hand should retry. The gate must authorize it, not deadlock (adversary HIGH #1).
  const payload = makeAgentPayload("ses_exec_notdone", "executor");
  const readTriage = () => ({ mode: "FULL", feature_id: "feat" });
  const readGateStateFn = () => ({ escalation_fallback: ["feat/task-1"] });
  const readHandRecordFn = () => ({ outcome: { status: "NOT_DONE" } });
  assert.equal(
    decide(payload, { readTriage, readGateStateFn, readHandRecordFn }).allow,
    true,
    "a NOT_DONE genuine run must authorize the K=1 escalation (no deadlock)"
  );
});

test("decide: ticket + FAILED record whose freeze MATCHES current HEAD → allow", () => {
  const payload = makeAgentPayload("ses_exec_freshok", "executor");
  const readTriage = () => ({ mode: "FULL", feature_id: "feat" });
  const readGateStateFn = () => ({ escalation_fallback: ["feat/task-1"] });
  const readHandRecordFn = () => ({ outcome: { status: "FAILED" }, freezeCommitSha: "abc123" });
  const headShaFn = () => "abc123"; // HEAD == record's freeze → fresh
  assert.equal(decide(payload, { readTriage, readGateStateFn, readHandRecordFn, headShaFn }).allow, true);
});

test("decide: ticket + FAILED record whose freeze DIFFERS from HEAD (stale) → deny", () => {
  // A stale FAILED record from a prior run/freeze must NOT authorize a later, unfailed escalation
  // (adversary HIGH #2 — record reuse). The freshness cross-check denies on a positive mismatch.
  const payload = makeAgentPayload("ses_exec_stale", "executor");
  const readTriage = () => ({ mode: "FULL", feature_id: "feat" });
  const readGateStateFn = () => ({ escalation_fallback: ["feat/task-1"] });
  const readHandRecordFn = () => ({ outcome: { status: "FAILED" }, freezeCommitSha: "OLD-freeze" });
  const headShaFn = () => "NEW-head"; // HEAD advanced past the record's freeze → stale
  const verdict = decide(payload, { readTriage, readGateStateFn, readHandRecordFn, headShaFn });
  assert.equal(verdict.allow, false, "a stale record (freeze != HEAD) must NOT unlock the Claude hand");
});

test("decide: ticket + FAILED record, HEAD unreadable → allow (freshness fails open)", () => {
  // When HEAD can't be read, the freshness check fails OPEN so a legit escalation never bricks;
  // the ticket + genuine-failure outcome still gate it.
  const payload = makeAgentPayload("ses_exec_nohead", "executor");
  const readTriage = () => ({ mode: "FULL", feature_id: "feat" });
  const readGateStateFn = () => ({ escalation_fallback: ["feat/task-1"] });
  const readHandRecordFn = () => ({ outcome: { status: "FAILED" }, freezeCommitSha: "abc123" });
  const headShaFn = () => null; // git unavailable
  assert.equal(decide(payload, { readTriage, readGateStateFn, readHandRecordFn, headShaFn }).allow, true);
});

test("decide: executor with ticket but record outcome DONE (not FAILED) → deny", () => {
  // A DONE run does not justify a Claude escape — only a genuine FAILED run does.
  const payload = makeAgentPayload("ses_exec_done", "executor");
  const readTriage = () => ({ mode: "FULL", feature_id: "feat" });
  const readGateStateFn = () => ({ escalation_fallback: ["feat/task-1"] });
  const readHandRecordFn = () => ({ outcome: { status: "DONE" } });
  const verdict = decide(payload, { readTriage, readGateStateFn, readHandRecordFn });
  assert.equal(verdict.allow, false, "a DONE run-record must NOT unlock the Claude hand escape");
});

test("decide: executor with non-empty ticket array but only a FORGED (recordless) entry → deny", () => {
  // Removes the old 'any non-empty escalation_fallback array unlocks' looseness: an echo-forged
  // ticket with no matching on-disk FAILED record never unlocks.
  const payload = makeAgentPayload("ses_exec_forged", "executor");
  const readTriage = () => ({ mode: "FULL", feature_id: "feat" });
  const readGateStateFn = () => ({ escalation_fallback: ["feat/forged-task"] });
  const readHandRecordFn = () => null;
  assert.equal(decide(payload, { readTriage, readGateStateFn, readHandRecordFn }).allow, false);
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

// ---------------------------------------------------------------------------
// trilho-3 — hand-routing gate
// executor, sniper, and test-author are HAND roles dispatched via spawn-hand.mjs
// (Ollama cheap hands). A MAIN-LOOP Agent of a hand role (no agent_id) is denied
// UNLESS a session-level escalation_fallback ticket exists — that ticket marks the
// legitimate K=1 escalation/transcription fallback. Eyes (planner, adversary, etc.)
// are unaffected. Gate 1 (triage) precedence is preserved.
// ---------------------------------------------------------------------------

test(
  "trilho-3 #1: executor, valid FULL triage, no escalation_fallback ticket → deny (spawn-hand)",
  () => {
    const payload = makeAgentPayload("ses_hand_exec", "executor");
    const readTriage = () => ({ mode: "FULL", feature_id: "feat" });
    const readGateStateFn = () => ({}); // no escalation_fallback ticket

    const verdict = decide(payload, { readTriage, readGateStateFn });

    assert.equal(verdict.allow, false, "main-loop executor must be denied without a fallback ticket");
    assert.equal(verdict.hookSpecificOutput.permissionDecision, "deny");
    assert.match(
      verdict.hookSpecificOutput.permissionDecisionReason,
      /spawn-hand/,
      "deny reason must reference spawn-hand routing",
    );
  },
);

test(
  "trilho-3 #2: sniper, valid triage, no ticket → deny (spawn-hand)",
  () => {
    const payload = makeAgentPayload("ses_hand_sniper", "sniper");
    const readTriage = () => ({ mode: "FULL", feature_id: "feat" });
    const readGateStateFn = () => ({});

    const verdict = decide(payload, { readTriage, readGateStateFn });

    assert.equal(verdict.allow, false, "main-loop sniper must be denied without a fallback ticket");
    assert.equal(verdict.hookSpecificOutput.permissionDecision, "deny");
    assert.match(verdict.hookSpecificOutput.permissionDecisionReason, /spawn-hand/);
  },
);

test(
  "trilho-3 #3: executor, valid triage, ticket mapping to an on-disk FAILED record → allow",
  () => {
    const payload = makeAgentPayload("ses_hand_exec_ok", "executor");
    const readTriage = () => ({ mode: "FULL", feature_id: "feat" });
    const readGateStateFn = () => ({ escalation_fallback: ["feat-a/task-1"] });
    const readHandRecordFn = (qid) => (qid === "feat-a/task-1" ? { outcome: { status: "FAILED" } } : null);

    const verdict = decide(payload, { readTriage, readGateStateFn, readHandRecordFn });

    assert.equal(verdict.allow, true, "executor must be allowed when a ticket maps to a FAILED run-record");
  },
);

test(
  "trilho-3 #4: adversary, valid triage, no ticket → allow (eyes unaffected, still records)",
  () => {
    const payload = makeAgentPayload("ses_hand_adv", "adversary");
    const readTriage = () => ({ mode: "FULL", feature_id: "feat" });
    const readGateStateFn = () => ({}); // no escalation_fallback ticket
    let recorded = false;
    const mergeGateStateFn = (_sid, patch) => {
      if (patch && patch.adversary_fired === true) recorded = true;
      return true;
    };

    const verdict = decide(payload, { readTriage, readGateStateFn, mergeGateStateFn });

    assert.equal(verdict.allow, true, "adversary (eye) must remain allowed without a fallback ticket");
    assert.equal(recorded, true, "adversary must still record adversary_fired");
  },
);

test(
  "trilho-3 #5: planner with both ceremony flags, no ticket → allow (eyes unaffected)",
  () => {
    const payload = makeAgentPayload("ses_hand_planner", "planner");
    const readTriage = () => ({ mode: "FULL", feature_id: "feat" });
    const readGateStateFn = () => ({ brainstormed: true, adversary_fired: true }); // no ticket

    const verdict = decide(payload, { readTriage, readGateStateFn });

    assert.equal(verdict.allow, true, "planner (eye) must be allowed by its own gate, not the hand gate");
  },
);

test(
  "trilho-3 #6: 'harness:executor', valid triage, no ticket → deny (bareRole normalization)",
  () => {
    const payload = makeAgentPayload("ses_hand_ns_exec", "harness:executor");
    const readTriage = () => ({ mode: "FULL", feature_id: "feat" });
    const readGateStateFn = () => ({});

    const verdict = decide(payload, { readTriage, readGateStateFn });

    assert.equal(verdict.allow, false, "namespaced executor must be normalized and denied");
    assert.match(verdict.hookSpecificOutput.permissionDecisionReason, /spawn-hand/);
  },
);

test(
  "trilho-3 #7: test-author, valid triage, no ticket → allow (main-loop Claude Agent in LOCAL — early-return before hand-routing gate)",
  () => {
    // UPDATED: test-author is now dispatched as a main-loop Claude Agent in BOTH local and headless.
    // It is the PRODUCER of the fidelity-pass and has no spawn-hand path (runLiveDispatch requires a
    // frozen test that does not yet exist at author time). The early-return fires before the hand-routing
    // gate for test-author in ALL modes — executor and sniper still go through the hand-routing gate.
    const payload = makeAgentPayload("ses_hand_ta", "test-author");
    const readTriage = () => ({ mode: "FULL", feature_id: "feat" });
    const readGateStateFn = () => ({}); // no escalation_fallback ticket — no longer needed for test-author

    const verdict = decide(payload, { readTriage, isHeadlessFn: () => false, readGateStateFn });

    assert.equal(verdict.allow, true, "test-author must always be allowed in LOCAL — it is the fidelity-pass producer and has no spawn-hand path");
  },
);

test(
  "trilho-3 #8: test-author, valid triage, ticket mapping to an on-disk FAILED record → allow (transcription fallback)",
  () => {
    const payload = makeAgentPayload("ses_hand_ta_ok", "test-author");
    const readTriage = () => ({ mode: "FULL", feature_id: "feat" });
    const readGateStateFn = () => ({ escalation_fallback: ["feat-a/task-1"] });
    const readHandRecordFn = (qid) => (qid === "feat-a/task-1" ? { outcome: { status: "FAILED" } } : null);

    const verdict = decide(payload, { readTriage, readGateStateFn, readHandRecordFn });

    assert.equal(verdict.allow, true, "test-author must be allowed for the transcription fallback when a ticket maps to a FAILED record");
  },
);

test(
  "trilho-3 #9: 'harness:test-author', valid triage, no ticket → allow (bareRole='test-author', early-return applies)",
  () => {
    // UPDATED: the early-return fires on bareRole('harness:test-author') === 'test-author', so the
    // namespaced form also always allows. Executor/sniper namespaced forms still go through the
    // hand-routing gate and are denied without a ticket (trilho-3 #6 for harness:executor).
    const payload = makeAgentPayload("ses_hand_ns_ta", "harness:test-author");
    const readTriage = () => ({ mode: "FULL", feature_id: "feat" });
    const readGateStateFn = () => ({}); // no ticket — no longer needed for test-author

    const verdict = decide(payload, { readTriage, isHeadlessFn: () => false, readGateStateFn });

    assert.equal(verdict.allow, true, "namespaced test-author must also be allowed — bareRole normalization resolves to 'test-author', early-return fires");
  },
);

test(
  "trilho-3 regression: executor with NO triage → Gate 1 deny naming triaging-requests (precedence preserved)",
  () => {
    const payload = makeAgentPayload("ses_hand_notriage", "executor");
    const readTriage = () => null; // no triage.json
    const readGateStateFn = () => ({}); // no ticket — but Gate 1 must fire FIRST

    const verdict = decide(payload, { readTriage, readGateStateFn });

    assert.equal(verdict.allow, false, "no-triage executor must still be denied");
    assert.ok(
      verdict.hookSpecificOutput.permissionDecisionReason.includes("triaging-requests"),
      "Gate 1 (triage) must take precedence over the hand-routing gate",
    );
  },
);

// ---------------------------------------------------------------------------
// trilho-4 — delivery-bash-gate capture rail
// In addition to the regate rail, decideBash DENIES a delivery command while any
// hand_finished task-id lacks a matching capture_verified task-id (same qualified
// `${feature_id}/${task_id}` shape and array-diff style as regate_pending vs regate_passed).
// A finished cheap-hand whose output has not been independently captured/verified blocks
// delivery. The two rails fire INDEPENDENTLY — either unmatched set denies.
// ---------------------------------------------------------------------------

test(
  "trilho-4 #1: Bash 'git push' with hand_finished unmatched by capture_verified → deny naming the pending capture",
  () => {
    const payload = makeBashPayload("ses_cap_blocked", "git push origin main");
    const readGateStateFn = () => ({ hand_finished: ["feat-a/task-1"] }); // no capture_verified

    const verdict = decide(payload, { readGateStateFn });

    assert.equal(verdict.allow, false, "git push must be denied while a capture is pending");
    assert.equal(verdict.hookSpecificOutput.permissionDecision, "deny");
    assert.ok(
      verdict.hookSpecificOutput.permissionDecisionReason.includes("feat-a/task-1"),
      `deny reason must name the pending capture — got: "${verdict.hookSpecificOutput.permissionDecisionReason}"`,
    );
    assert.ok(
      verdict.hookSpecificOutput.permissionDecisionReason.toLowerCase().includes("capture-verified"),
      "deny reason must reference capture-verified",
    );
  },
);

test(
  "trilho-4 #2: Bash 'git push' with hand_finished matched by capture_verified, no unmatched regate → allow",
  () => {
    const payload = makeBashPayload("ses_cap_ok", "git push origin main");
    const readGateStateFn = () => ({
      hand_finished: ["feat-a/task-1"],
      capture_verified: ["feat-a/task-1"],
    });

    const verdict = decide(payload, { readGateStateFn });

    assert.equal(verdict.allow, true, "git push must be allowed once every capture is matched");
  },
);

test(
  "trilho-4 #3: Bash 'git status' with hand_finished unmatched → allow (read-only never gated)",
  () => {
    const payload = makeBashPayload("ses_cap_readonly", "git status");
    const readGateStateFn = () => ({ hand_finished: ["feat-a/task-1"] }); // no capture_verified

    const verdict = decide(payload, { readGateStateFn });

    assert.equal(verdict.allow, true, "read-only git status must always pass regardless of capture state");
  },
);

test(
  "trilho-4 #4: Bash 'git push' with unmatched regate_pending and NO hand_finished → deny (existing regate rail intact)",
  () => {
    const payload = makeBashPayload("ses_cap_regate_intact", "git push origin main");
    const readGateStateFn = () => ({ regate_pending: ["feat-a/x"] }); // no regate_passed, no hand_finished

    const verdict = decide(payload, { readGateStateFn });

    assert.equal(verdict.allow, false, "the existing regate rail must still fire post-extension");
    assert.equal(verdict.hookSpecificOutput.permissionDecision, "deny");
    assert.ok(
      verdict.hookSpecificOutput.permissionDecisionReason.includes("feat-a/x"),
      "deny reason must name the unmatched regate entry",
    );
  },
);

test(
  "trilho-4 #5: Bash 'git push' with regate matched but hand_finished unmatched → deny (capture rail fires independently)",
  () => {
    const payload = makeBashPayload("ses_cap_independent", "git push origin main");
    const readGateStateFn = () => ({
      regate_pending: ["feat-a/x"],
      regate_passed: ["feat-a/x"], // regate rail satisfied
      hand_finished: ["feat-a/task-1"], // but capture rail unmatched
    });

    const verdict = decide(payload, { readGateStateFn });

    assert.equal(verdict.allow, false, "capture rail must deny even when the regate rail is satisfied");
    assert.equal(verdict.hookSpecificOutput.permissionDecision, "deny");
    assert.ok(
      verdict.hookSpecificOutput.permissionDecisionReason.includes("feat-a/task-1"),
      "deny reason must name the pending capture",
    );
  },
);

// ---------------------------------------------------------------------------
// Real-file capture rail — reads the on-disk run-record directly, independent of the
// hand_finished/capture_verified session-scoped arrays above (which a prior incident showed
// can be skipped for EVERY dispatch in a run, leaving those arrays with nothing to compare).
// ---------------------------------------------------------------------------

test("real-file capture rail: denies push when a real DONE hand-record has no capturedVerifiedAt (hand_finished was never stamped)", () => {
  const payload = makeBashPayload("ses_realfile_1", "git push");
  const result = decide(payload, {
    readGateStateFn: () => ({ feature_id: "feat-real" }),
    gitStateFn: () => null,
    isHeadlessFn: () => false,
    headShaFn: () => "deadbeef",
    isAncestorFn: (sha) => sha === "deadbeef",
    listHandRecordsForFeatureFn: (featureId) => {
      assert.equal(featureId, "feat-real");
      return [{
        taskId: "task-1",
        record: {
          freezeCommitSha: "deadbeef",
          outcome: { status: "DONE", scopeViolations: [], frozenViolations: [] },
        },
      }];
    },
  });
  assert.equal(result.allow, false);
  assert.match(result.hookSpecificOutput.permissionDecisionReason, /task-1/);
});

test("real-file capture rail: allows push when the real hand-record already carries capturedVerifiedAt", () => {
  const payload = makeBashPayload("ses_realfile_2", "git push");
  const result = decide(payload, {
    readGateStateFn: () => ({ feature_id: "feat-real" }),
    gitStateFn: () => null,
    isHeadlessFn: () => false,
    headShaFn: () => "deadbeef",
    isAncestorFn: () => true,
    listHandRecordsForFeatureFn: () => [{
      taskId: "task-1",
      record: {
        freezeCommitSha: "deadbeef",
        capturedVerifiedAt: "2026-07-01T00:00:00.000Z",
        outcome: { status: "DONE", scopeViolations: [], frozenViolations: [] },
      },
    }],
  });
  assert.equal(result.allow, true);
});

test("real-file capture rail: denies push with a distinct hard-stop message on a scope violation, even if capturedVerifiedAt is set", () => {
  const payload = makeBashPayload("ses_realfile_3", "git push");
  const result = decide(payload, {
    readGateStateFn: () => ({ feature_id: "feat-real" }),
    gitStateFn: () => null,
    isHeadlessFn: () => false,
    headShaFn: () => "deadbeef",
    isAncestorFn: () => true,
    listHandRecordsForFeatureFn: () => [{
      taskId: "task-1",
      record: {
        freezeCommitSha: "deadbeef",
        capturedVerifiedAt: "2026-07-01T00:00:00.000Z",
        outcome: { status: "FAILED", scopeViolations: ["src/out-of-scope.ts"], frozenViolations: [] },
      },
    }],
  });
  assert.equal(result.allow, false);
  assert.match(result.hookSpecificOutput.permissionDecisionReason, /scope/i);
  assert.match(result.hookSpecificOutput.permissionDecisionReason, /task-1/);
});

test("real-file capture rail: ignores a hand-record whose freezeCommitSha is not an ancestor of HEAD (abandoned/unrelated branch)", () => {
  const payload = makeBashPayload("ses_realfile_4", "git push");
  const result = decide(payload, {
    readGateStateFn: () => ({ feature_id: "feat-real" }),
    gitStateFn: () => null,
    isHeadlessFn: () => false,
    headShaFn: () => "deadbeef",
    isAncestorFn: () => false,
    listHandRecordsForFeatureFn: () => [{
      taskId: "task-1",
      record: { freezeCommitSha: "stale-sha", outcome: { status: "DONE", scopeViolations: [], frozenViolations: [] } },
    }],
  });
  assert.equal(result.allow, true);
});

test("real-file capture rail: denies a freeze-commit for the NEXT task (best-effort early trigger) when the current feature has an unresolved hand-record", () => {
  const payload = makeBashPayload("ses_freeze_early", 'git commit -m "test(cron): freeze locked tests for task-2"');
  const result = decide(payload, {
    readGateStateFn: () => ({ feature_id: "feat-real" }),
    gitStateFn: () => null,
    isHeadlessFn: () => false,
    headShaFn: () => "deadbeef",
    isAncestorFn: () => true,
    listHandRecordsForFeatureFn: () => [{
      taskId: "task-1",
      record: { freezeCommitSha: "deadbeef", outcome: { status: "DONE", scopeViolations: [], frozenViolations: [] } },
    }],
  });
  assert.equal(result.allow, false);
  assert.match(result.hookSpecificOutput.permissionDecisionReason, /task-1/);
});

test("real-file capture rail: allows an ordinary git commit (not a freeze-commit message) even with an unresolved hand-record — the freeze-commit trigger is best-effort, not the mandatory gate", () => {
  const payload = makeBashPayload("ses_freeze_ordinary", 'git commit -m "chore: update memory notes"');
  const result = decide(payload, {
    readGateStateFn: () => ({ feature_id: "feat-real" }),
    gitStateFn: () => null,
    isHeadlessFn: () => false,
    headShaFn: () => "deadbeef",
    isAncestorFn: () => true,
    listHandRecordsForFeatureFn: () => [{
      taskId: "task-1",
      record: { freezeCommitSha: "deadbeef", outcome: { status: "DONE", scopeViolations: [], frozenViolations: [] } },
    }],
  });
  assert.equal(result.allow, true);
});

// ---------------------------------------------------------------------------
// Branch/commit rail (push-branch-gate): a delivery command must run from a feature
// branch with committed work — never from main/master, never with zero commits ahead.
// gitStateFn is an injectable seam; its decide()-level default is a no-op so existing
// callers are unaffected (the real git probe is injected at the processInput layer).
// ---------------------------------------------------------------------------

test("push-branch-gate: git push from main → deny", () => {
  const payload = makeBashPayload("ses_pbg1", "git push origin main");
  const verdict = decide(payload, {
    readGateStateFn: () => ({}),
    gitStateFn: () => ({ branch: "main", commitsAhead: 3 }),
  });
  assert.equal(verdict.allow, false);
  assert.equal(verdict.hookSpecificOutput.permissionDecision, "deny");
  assert.match(verdict.hookSpecificOutput.permissionDecisionReason, /branch|main/i);
});

test("push-branch-gate: git push from master → deny", () => {
  const payload = makeBashPayload("ses_pbg2", "git push");
  const verdict = decide(payload, {
    readGateStateFn: () => ({}),
    gitStateFn: () => ({ branch: "master", commitsAhead: 1 }),
  });
  assert.equal(verdict.allow, false);
  assert.equal(verdict.hookSpecificOutput.permissionDecision, "deny");
});

test("push-branch-gate: feature branch with commits ahead → allow (this rail)", () => {
  const payload = makeBashPayload("ses_pbg3", "git push -u origin feat/x");
  const verdict = decide(payload, {
    readGateStateFn: () => ({}),
    gitStateFn: () => ({ branch: "feat/x", commitsAhead: 2 }),
  });
  assert.equal(verdict.allow, true);
});

test("push-branch-gate: feature branch with ZERO commits ahead → deny naming commit", () => {
  const payload = makeBashPayload("ses_pbg4", "gh pr create");
  const verdict = decide(payload, {
    readGateStateFn: () => ({}),
    gitStateFn: () => ({ branch: "feat/x", commitsAhead: 0 }),
  });
  assert.equal(verdict.allow, false);
  assert.match(verdict.hookSpecificOutput.permissionDecisionReason, /commit/i);
});

test("push-branch-gate: base unresolved (commitsAhead null) on feature branch → allow (branch floor only)", () => {
  const payload = makeBashPayload("ses_pbg5", "git push");
  const verdict = decide(payload, {
    readGateStateFn: () => ({}),
    gitStateFn: () => ({ branch: "feat/x", commitsAhead: null }),
  });
  assert.equal(verdict.allow, true);
});

test("push-branch-gate: git probe error (gitStateFn null) → allow (fail-open, never brick)", () => {
  const payload = makeBashPayload("ses_pbg6", "git push");
  const verdict = decide(payload, {
    readGateStateFn: () => ({}),
    gitStateFn: () => null,
  });
  assert.equal(verdict.allow, true);
});

test("push-branch-gate: read-only command on main → allow (not a delivery command)", () => {
  const payload = makeBashPayload("ses_pbg7", "git status");
  const verdict = decide(payload, {
    readGateStateFn: () => ({}),
    gitStateFn: () => ({ branch: "main", commitsAhead: 0 }),
  });
  assert.equal(verdict.allow, true);
});

test("push-branch-gate: decide() WITHOUT gitStateFn is inert (back-compat — existing callers unaffected)", () => {
  const payload = makeBashPayload("ses_pbg8", "git push");
  const verdict = decide(payload, { readGateStateFn: () => ({}) }); // no gitStateFn injected
  assert.equal(verdict.allow, true, "the branch rail must not fire without an injected git probe");
});

// ---------------------------------------------------------------------------
// LOCKED — computeGitState base resolution (never @{u}, always origin default)
// AC-CORE: after git push the feature branch's own upstream points at HEAD → @{u}..HEAD == 0.
// The fix resolves the merge destination (origin default) instead, never the branch's upstream.
// ---------------------------------------------------------------------------

test(
  "LOCKED computeGitState AC-CORE: upstream==HEAD but ahead-of-default>0 → commitsAhead reflects origin/main, not zeroed upstream",
  () => {
    // Simulates: feature branch pushed, origin/<feat>==HEAD (upstream 0 commits ahead),
    // but there ARE 3 real commits ahead of origin/main (the merge destination).
    // Bug: old @{u} code → origin/feat → 0. Fix: origin/HEAD → origin/main → 3.
    let atUQueried = false;
    function fakeGit(args) {
      if (args.some((a) => a.includes("@{u}"))) {
        atUQueried = true;
        throw new Error("@{u} must NOT be used — this is the bug");
      }
      const cmd = args.join(" ");
      if (cmd === "rev-parse --abbrev-ref HEAD") return "feat/my-feature";
      if (cmd === "symbolic-ref refs/remotes/origin/HEAD") return "refs/remotes/origin/main";
      if (cmd === "rev-list --count origin/main..HEAD") return "3";
      throw new Error(`unexpected git call: ${cmd}`);
    }
    const state = computeGitState(fakeGit);
    assert.ok(state !== null, "must return a state object");
    assert.equal(state.commitsAhead, 3, "commitsAhead must be 3 (origin/main), not 0 (@{u})");
    assert.equal(state.branch, "feat/my-feature");
    assert.equal(atUQueried, false, "@{u} must never be queried by computeGitState");
  },
);

test(
  "LOCKED computeGitState: origin/HEAD unset → falls back to origin/main, commitsAhead === 2",
  () => {
    function fakeGit(args) {
      if (args.some((a) => a.includes("@{u}"))) throw new Error("@{u} must NOT be used");
      const cmd = args.join(" ");
      if (cmd === "rev-parse --abbrev-ref HEAD") return "feat/x";
      if (cmd === "symbolic-ref refs/remotes/origin/HEAD") throw new Error("origin/HEAD not set");
      if (cmd === "rev-parse --verify --quiet origin/main") return "abc123sha";
      if (cmd === "rev-list --count origin/main..HEAD") return "2";
      throw new Error(`unexpected git call: ${cmd}`);
    }
    const state = computeGitState(fakeGit);
    assert.equal(state?.commitsAhead, 2, "commitsAhead must be 2 via origin/main fallback");
    assert.equal(state?.branch, "feat/x");
  },
);

test(
  "LOCKED computeGitState: origin/HEAD unset, origin/main also fails → falls back to origin/master",
  () => {
    function fakeGit(args) {
      if (args.some((a) => a.includes("@{u}"))) throw new Error("@{u} must NOT be used");
      const cmd = args.join(" ");
      if (cmd === "rev-parse --abbrev-ref HEAD") return "feat/x";
      if (cmd === "symbolic-ref refs/remotes/origin/HEAD") throw new Error("not set");
      if (cmd === "rev-parse --verify --quiet origin/main") throw new Error("not found");
      if (cmd === "rev-parse --verify --quiet origin/master") return "def456sha";
      if (cmd === "rev-list --count origin/master..HEAD") return "1";
      throw new Error(`unexpected git call: ${cmd}`);
    }
    const state = computeGitState(fakeGit);
    assert.equal(state?.commitsAhead, 1, "commitsAhead must be 1 via origin/master fallback");
  },
);

test(
  "LOCKED computeGitState: no base resolvable (origin/HEAD, origin/main, origin/master all fail) → commitsAhead === null (fail-open), branch still returned",
  () => {
    function fakeGit(args) {
      if (args.some((a) => a.includes("@{u}"))) throw new Error("@{u} must NOT be used");
      const cmd = args.join(" ");
      if (cmd === "rev-parse --abbrev-ref HEAD") return "feat/x";
      if (cmd === "symbolic-ref refs/remotes/origin/HEAD") throw new Error("not set");
      if (cmd === "rev-parse --verify --quiet origin/main") throw new Error("not found");
      if (cmd === "rev-parse --verify --quiet origin/master") throw new Error("not found");
      throw new Error(`unexpected git call: ${cmd}`);
    }
    const state = computeGitState(fakeGit);
    assert.ok(state !== null, "must return a state object even with no base resolvable");
    assert.equal(state.commitsAhead, null, "commitsAhead must be null (fail-open)");
    assert.equal(state.branch, "feat/x", "branch must still be returned");
  },
);

test(
  "LOCKED computeGitState: zero commits ahead of base → commitsAhead === 0 (consumer blocks genuine empty push)",
  () => {
    function fakeGit(args) {
      if (args.some((a) => a.includes("@{u}"))) throw new Error("@{u} must NOT be used");
      const cmd = args.join(" ");
      if (cmd === "rev-parse --abbrev-ref HEAD") return "feat/x";
      if (cmd === "symbolic-ref refs/remotes/origin/HEAD") return "refs/remotes/origin/main";
      if (cmd === "rev-list --count origin/main..HEAD") return "0";
      throw new Error(`unexpected git call: ${cmd}`);
    }
    const state = computeGitState(fakeGit);
    assert.equal(state?.commitsAhead, 0, "zero commits must be 0 (not null) so consumer can block genuine empty push");
  },
);

test(
  "LOCKED computeGitState: rev-list count throws → commitsAhead === null but branch still returned (fail-open preserved)",
  () => {
    function fakeGit(args) {
      const cmd = args.join(" ");
      if (cmd === "rev-parse --abbrev-ref HEAD") return "feat/x";
      if (cmd === "symbolic-ref refs/remotes/origin/HEAD") return "refs/remotes/origin/main";
      if (cmd === "rev-list --count origin/main..HEAD") throw new Error("rev-list failed");
      throw new Error(`unexpected git call: ${cmd}`);
    }
    const state = computeGitState(fakeGit);
    assert.ok(state !== null, "must return a state object even when rev-list throws");
    assert.equal(state.commitsAhead, null, "commitsAhead must be null (fail-open) when count step throws");
    assert.equal(state.branch, "feat/x", "branch must still be returned when count step throws");
  },
);

test(
  "LOCKED computeGitState: first git call (branch resolution) throws → computeGitState propagates throw, pinning defaultGitState fail-open contract",
  () => {
    function throwingGit() {
      throw new Error("git not available");
    }
    // branch is read outside any try — the throw propagates unchanged.
    // This is exactly what defaultGitState's try/catch catches and converts to null.
    assert.throws(
      () => computeGitState(throwingGit),
      /git not available/,
      "computeGitState must propagate a branch-resolution throw (defaultGitState wrapper converts it to null)",
    );
  },
);

// ---------------------------------------------------------------------------
// LOCKED — Issue-form advisory (adviseIssueForm pure fn + wiring in decideBash)
// AC-1: adviseIssueForm pure function contracts
// ---------------------------------------------------------------------------

test(
  "LOCKED issue-form-advisory #1: gh issue create + existsFn=true + abs cwd → returns advisory string (truthy)",
  () => {
    const result = adviseIssueForm("gh issue create --title x", "/abs/repo", () => true);
    assert.ok(result, "advisory must be a truthy string when form exists in abs cwd");
    assert.equal(typeof result, "string", "advisory must be a string");
  },
);

test(
  "LOCKED issue-form-advisory #2: non-gh-issue command → null",
  () => {
    const result = adviseIssueForm("ls -la", "/abs/repo", () => true);
    assert.equal(result, null, "non-gh-issue command must return null");
  },
);

test(
  "LOCKED issue-form-advisory #3: command already contains harness:ready → null (no re-nudge)",
  () => {
    const result = adviseIssueForm(
      'gh issue create --title "[harness] foo" --label "harness:ready"',
      "/abs/repo",
      () => true,
    );
    assert.equal(result, null, "command already following convention must return null");
  },
);

test(
  "LOCKED issue-form-advisory #4: relative cwd or empty or undefined → null (fail-open, no nudge)",
  () => {
    const resultRelative = adviseIssueForm("gh issue create --title x", "repo", () => true);
    assert.equal(resultRelative, null, "relative cwd must return null");

    const resultEmpty = adviseIssueForm("gh issue create --title x", "", () => true);
    assert.equal(resultEmpty, null, "empty cwd must return null");

    const resultUndefined = adviseIssueForm("gh issue create --title x", undefined, () => true);
    assert.equal(resultUndefined, null, "undefined cwd must return null");
  },
);

test(
  "LOCKED issue-form-advisory #5: existsFn=()=>false → null (no form vendored → no nudge)",
  () => {
    const result = adviseIssueForm("gh issue create --title x", "/abs/repo", () => false);
    assert.equal(result, null, "no form vendored must return null");
  },
);

// AC-2: decide() Bash advisory path
test(
  "LOCKED issue-form-advisory #6: decide() gh issue create with issueFormExistsFn=true → allow + hookSpecificOutput.additionalContext (non-empty, no permissionDecision)",
  () => {
    const payload = {
      session_id: "ses_issue_adv",
      tool_name: "Bash",
      tool_input: { command: "gh issue create --title foo" },
      cwd: "/abs/repo",
    };
    const verdict = decide(payload, {
      issueFormExistsFn: () => true,
      readGateStateFn: () => ({}),
    });
    assert.equal(verdict.allow, true, "advisory path must allow");
    assert.ok(verdict.hookSpecificOutput, "advisory must set hookSpecificOutput");
    assert.equal(
      typeof verdict.hookSpecificOutput.additionalContext,
      "string",
      "hookSpecificOutput must have a string additionalContext",
    );
    assert.ok(
      verdict.hookSpecificOutput.additionalContext.length > 0,
      "additionalContext must be non-empty",
    );
    assert.equal(
      verdict.hookSpecificOutput.permissionDecision,
      undefined,
      "advisory hookSpecificOutput must NOT contain permissionDecision",
    );
  },
);

// AC-3: HIGH regression guard — composite command must hit delivery rails, never the advisory allow
test(
  "LOCKED issue-form-advisory #7 HIGH regression: 'gh issue create && git push' → delivery deny (permissionDecision:deny), never advisory",
  () => {
    const payload = {
      session_id: "ses_composite_guard",
      tool_name: "Bash",
      tool_input: { command: "gh issue create --title foo && git push origin HEAD" },
      cwd: "/abs/repo",
    };
    const verdict = decide(payload, {
      issueFormExistsFn: () => true,
      readGateStateFn: () => ({}),
      gitStateFn: () => ({ branch: "feat/x", commitsAhead: 0 }),
    });
    assert.equal(verdict.allow, false, "composite command must be denied by delivery rails");
    assert.equal(
      verdict.hookSpecificOutput.permissionDecision,
      "deny",
      "composite command must emit permissionDecision:deny (delivery rail), not an advisory allow",
    );
  },
);

// AC-4: processInput with advisory
test(
  "LOCKED issue-form-advisory #8: processInput advisory command → JSON output with additionalContext, no permissionDecision",
  () => {
    const raw = JSON.stringify({
      session_id: "ses_proc_adv",
      tool_name: "Bash",
      tool_input: { command: "gh issue create --title bar" },
      cwd: "/abs/repo",
    });
    const result = processInput(raw, { issueFormExistsFn: () => true });
    assert.notEqual(result.output, null, "advisory must produce non-null output");
    const parsed = JSON.parse(result.output);
    assert.ok(
      parsed.hookSpecificOutput && typeof parsed.hookSpecificOutput.additionalContext === "string",
      "output must contain hookSpecificOutput.additionalContext",
    );
    assert.equal(
      parsed.hookSpecificOutput.permissionDecision,
      undefined,
      "advisory output must NOT contain permissionDecision",
    );
  },
);

test(
  "LOCKED issue-form-advisory #9: processInput plain allow command → output null",
  () => {
    const raw = JSON.stringify({
      session_id: "ses_proc_plain",
      tool_name: "Bash",
      tool_input: { command: "ls" },
      cwd: "/abs/repo",
    });
    const result = processInput(raw, { issueFormExistsFn: () => true });
    assert.equal(result.output, null, "plain allow must produce null output");
  },
);

test(
  "LOCKED issue-form-advisory #10: processInput existing deny still emits permissionDecision:deny (no regression)",
  () => {
    // git push on main → deny via branch rail
    const raw = JSON.stringify({
      session_id: "ses_proc_deny_regression",
      tool_name: "Bash",
      tool_input: { command: "git push origin main" },
      cwd: "/abs/repo",
    });
    const result = processInput(raw, {
      issueFormExistsFn: () => false,
      gitStateFn: () => ({ branch: "main", commitsAhead: 3 }),
    });
    assert.notEqual(result.output, null, "deny must produce non-null output");
    const parsed = JSON.parse(result.output);
    assert.equal(
      parsed.hookSpecificOutput.permissionDecision,
      "deny",
      "existing deny path must still emit permissionDecision:deny (no regression from advisory change)",
    );
  },
);

// AC-5: inert default (unit callers without issueFormExistsFn are unaffected)
test(
  "LOCKED issue-form-advisory #11: decide() without issueFormExistsFn → inert (default ()=>false, allow true, no hookSpecificOutput)",
  () => {
    const payload = {
      session_id: "ses_inert_default",
      tool_name: "Bash",
      tool_input: { command: "gh issue create" },
      cwd: "/abs/repo",
    };
    // No issueFormExistsFn injected — default inside decide() is () => false
    const verdict = decide(payload, { readGateStateFn: () => ({}) });
    assert.equal(verdict.allow, true, "inert default must allow");
    assert.equal(
      verdict.hookSpecificOutput,
      undefined,
      "inert default must not set hookSpecificOutput",
    );
  },
);

// ---------------------------------------------------------------------------
// LOCKED — protected-branch-default-aware
// The protected-branch floor must block delivery from the repo's ACTUAL default
// branch, not just hardcoded main/master. computeGitState must surface
// defaultBranch; decideBash must generalize the floor to cover it.
// ---------------------------------------------------------------------------

test(
  "LOCKED default-branch #1: computeGitState surfaces defaultBranch from origin/HEAD (develop)",
  () => {
    function fakeGit(args) {
      const cmd = args.join(" ");
      if (cmd === "rev-parse --abbrev-ref HEAD") return "develop";
      if (cmd === "symbolic-ref refs/remotes/origin/HEAD") return "refs/remotes/origin/develop";
      if (cmd === "rev-list --count origin/develop..HEAD") return "3";
      throw new Error(`unexpected git call: ${cmd}`);
    }
    const state = computeGitState(fakeGit);
    assert.equal(state.defaultBranch, "develop", "defaultBranch must be 'develop' (stripped from refs/remotes/origin/develop)");
    assert.equal(state.commitsAhead, 3, "commitsAhead must be 3");
  },
);

test(
  "LOCKED default-branch #2: computeGitState defaultBranch null when no base resolvable",
  () => {
    function fakeGit(args) {
      const cmd = args.join(" ");
      if (cmd === "rev-parse --abbrev-ref HEAD") return "feat/x";
      if (cmd === "symbolic-ref refs/remotes/origin/HEAD") throw new Error("not set");
      if (cmd === "rev-parse --verify --quiet origin/main") throw new Error("not found");
      if (cmd === "rev-parse --verify --quiet origin/master") throw new Error("not found");
      throw new Error(`unexpected git call: ${cmd}`);
    }
    const state = computeGitState(fakeGit);
    assert.equal(state.defaultBranch, null, "defaultBranch must be null when base is unresolvable");
  },
);

test(
  "LOCKED default-branch #3: decideBash denies delivery from the default branch (develop) even with commits ahead",
  () => {
    const payload = makeBashPayload("ses_db3", "git push");
    const verdict = decide(payload, {
      readGateStateFn: () => ({}),
      gitStateFn: () => ({ branch: "develop", commitsAhead: 3, defaultBranch: "develop" }),
    });
    assert.equal(verdict.allow, false, "delivery from default branch must be denied");
    assert.equal(verdict.hookSpecificOutput.permissionDecision, "deny");
    assert.ok(
      verdict.hookSpecificOutput.permissionDecisionReason.includes("develop"),
      `deny reason must mention the branch — got: "${verdict.hookSpecificOutput.permissionDecisionReason}"`,
    );
    assert.ok(
      !verdict.hookSpecificOutput.permissionDecisionReason.toLowerCase().includes("zero commits"),
      "deny must be the protected-branch deny, NOT the zero-commits deny",
    );
  },
);

test(
  "LOCKED default-branch #4: decideBash allows a feature branch when defaultBranch is develop",
  () => {
    const payload = makeBashPayload("ses_db4", "git push -u origin feat/x");
    const verdict = decide(payload, {
      readGateStateFn: () => ({}),
      gitStateFn: () => ({ branch: "feat/x", commitsAhead: 2, defaultBranch: "develop" }),
    });
    assert.equal(verdict.allow, true, "feature branch push must be allowed when it is not the default branch");
  },
);

test(
  "LOCKED default-branch #5: back-compat — main and master still denied without defaultBranch field",
  () => {
    const payloadMain = makeBashPayload("ses_db5a", "git push");
    const verdictMain = decide(payloadMain, {
      readGateStateFn: () => ({}),
      gitStateFn: () => ({ branch: "main", commitsAhead: 3 }), // NO defaultBranch key
    });
    assert.equal(verdictMain.allow, false, "main must still be denied without defaultBranch field");
    assert.equal(verdictMain.hookSpecificOutput.permissionDecision, "deny");

    const payloadMaster = makeBashPayload("ses_db5b", "gh pr create");
    const verdictMaster = decide(payloadMaster, {
      readGateStateFn: () => ({}),
      gitStateFn: () => ({ branch: "master", commitsAhead: 1 }), // NO defaultBranch key
    });
    assert.equal(verdictMaster.allow, false, "master must still be denied without defaultBranch field");
    assert.equal(verdictMaster.hookSpecificOutput.permissionDecision, "deny");
  },
);

test(
  "LOCKED default-branch #6: feature/develop-stuff must NOT be denied — only exact branch match denies",
  () => {
    const payload = makeBashPayload("ses_db6", "git push -u origin feature/develop-stuff");
    const verdict = decide(payload, {
      readGateStateFn: () => ({}),
      gitStateFn: () => ({ branch: "feature/develop-stuff", commitsAhead: 2, defaultBranch: "develop" }),
    });
    assert.equal(verdict.allow, true, "substring 'develop' in branch name must NOT trigger the floor; only exact equality denies");
  },
);

// ---------------------------------------------------------------------------
// LOCKED — test-author is a main-loop Claude Agent in LOCAL and HEADLESS
// The test-author is the PRODUCER of the fidelity-pass (it authors the red
// locked test, validated by compliance in step 1b). It must never be blocked
// by the fidelity rail it serves, and it has NO spawn-hand path: runLiveDispatch
// requires a frozen test that does not yet exist at author time. Its safety
// controls are the compliance eye (step 1b) + the freeze content-hash (step 1c).
// ---------------------------------------------------------------------------

test(
  "decide: LOCAL test-author main-loop Agent → allow (fidelity-pass producer, no spawn-hand path)",
  () => {
    const payload = makeAgentPayload("ses_ta_local_allow", "test-author");
    // LOCAL: isHeadlessFn returns false
    // triage with FULL mode (Gate 1 would be satisfied)
    // gate-state with NO escalation_fallback (old hand-routing rail would deny without this)
    const readTriage = () => ({ mode: "FULL", feature_id: "feat" });
    const readGateStateFn = () => ({}); // no escalation_fallback ticket
    const verdict = decide(payload, {
      readTriage,
      isHeadlessFn: () => false,
      readGateStateFn,
    });
    assert.equal(
      verdict.allow,
      true,
      "LOCAL test-author must always be allowed — it is the fidelity-pass producer and has no spawn-hand path",
    );
  },
);
