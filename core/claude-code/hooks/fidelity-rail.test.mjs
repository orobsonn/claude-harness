/**
 * @description Locked tests for the fidelity rail — a new gate added to entry-gate.mjs
 * (PreToolUse) + a new `fidelity-pass` marker in mark.mjs / stamp-triage.mjs.
 *
 * These 7 tests FAIL RED until the production code is implemented. They pin the
 * observable behavior of the fidelity rail and must never be relaxed to make code pass.
 *
 * Seams assumed on decide() (not yet present in production):
 *   - deps.readDescriptorFn: (descriptorPath: string) => {feature_id, task_id} | null
 *     Injected into decideBash via the existing deps forwarding pattern.
 *     Activated when the Bash command includes 'spawn-hand.mjs' — the production default
 *     reads the JSON descriptor file at the path extracted from `--descriptor <path>`.
 *
 * Existing seam changes assumed:
 *   - The headless fast-path (isHeadlessFn() => true) no longer unconditionally allows
 *     all HAND_ROLES. For role === 'executor', it additionally reads fidelity_pass from
 *     gate-state and denies when the array is empty. test-author and sniper remain
 *     unconditionally allowed on the headless path.
 *
 * Run with: node --test core/hooks/fidelity-rail.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { decide } from "./entry-gate.mjs";
import { handle } from "./stamp-triage.mjs";
import { parseArgs, run } from "./mark.mjs";

// ---------------------------------------------------------------------------
// Helpers — mirrored from entry-gate.test.mjs and stamp-triage.test.mjs
// ---------------------------------------------------------------------------

/**
 * Runs fn inside a fresh OS tmpdir (chdir'd to it), then restores cwd and removes the dir.
 * gate-lib resolves .claude/plans/.state relative to cwd — chdir isolation is required.
 * @param {() => void} fn
 */
function withTempDir(fn) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fidelity-rail-test-"));
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
 * @param {object} [extra]
 */
function makeAgentPayload(sessionId, subagentType, extra = {}) {
  return {
    session_id: sessionId,
    tool_name: "Agent",
    tool_input: { subagent_type: subagentType },
    ...extra,
  };
}

/**
 * Builds a minimal PreToolUse Bash payload.
 * @param {string} sessionId
 * @param {string} command
 * @param {object} [extra]
 */
function makeBashPayload(sessionId, command, extra = {}) {
  return {
    session_id: sessionId,
    tool_name: "Bash",
    tool_input: { command },
    ...extra,
  };
}

/**
 * Builds a PostToolUse(Bash) payload for the fidelity-pass marker,
 * matching the shape stamp-triage.handle() reads.
 * @param {string} sessionId
 * @param {string} featureId
 * @param {string} taskId
 * @param {object} [extra]
 */
function makeFidelityPassPayload(sessionId, featureId, taskId, extra = {}) {
  return {
    session_id: sessionId,
    tool_name: "Bash",
    tool_input: {
      command: `node .claude/hooks/mark.mjs fidelity-pass --feature-id ${featureId} --task-id ${taskId}`,
    },
    tool_response: JSON.stringify({ marker: "fidelity-pass", feature_id: featureId, task_id: taskId }),
    ...extra,
  };
}

/**
 * Returns a valid FULL triage object for the given session.
 * feature_id is 'F', task_id 'T' (canonical qualified id 'F/T') across all fidelity tests.
 * @param {string} [sessionId]
 * @returns {{session_id: string, mode: string, feature_id: string}}
 */
function fullTriage(sessionId = "ses_fid") {
  return { session_id: sessionId, mode: "FULL", feature_id: "F" };
}

// ---------------------------------------------------------------------------
// FIDELITY-1 (Assertion 1)
//
// Given:  PreToolUse(Bash) command = spawn-hand.mjs --descriptor d.json
//         readDescriptorFn returning { feature_id: 'F', task_id: 'T' }
//         gate-state fidelity_pass: []
// When:   decide()
// Then:   deny — hookSpecificOutput.permissionDecision === 'deny'
//         and reason names the missing compliance-fidelity pass for the task (F/T)
// ---------------------------------------------------------------------------

test(
  "FIDELITY-1: spawn-hand.mjs + descriptor {F,T} + fidelity_pass=[] → deny naming missing fidelity-pass for F/T",
  () => {
    const payload = makeBashPayload(
      "ses_fid1",
      "node .claude/skills/orchestrating-delivery/references/spawn-hand.mjs --descriptor d.json",
    );
    const readDescriptorFn = () => ({ feature_id: "F", task_id: "T" });
    const readGateStateFn = () => ({ fidelity_pass: [] });

    const verdict = decide(payload, { readDescriptorFn, readGateStateFn });

    assert.equal(verdict.allow, false, "spawn-hand.mjs must be denied when fidelity_pass is empty");
    assert.equal(
      verdict.hookSpecificOutput.permissionDecision,
      "deny",
      "permissionDecision must be 'deny'",
    );
    const reason = verdict.hookSpecificOutput.permissionDecisionReason;
    assert.ok(
      reason.toLowerCase().includes("fidelity"),
      `reason must name the fidelity-pass requirement — got: "${reason}"`,
    );
    assert.ok(
      reason.includes("F/T"),
      `reason must name the qualified task id F/T — got: "${reason}"`,
    );
  },
);

// ---------------------------------------------------------------------------
// FIDELITY-2 (Assertion 2)
//
// Given:  same spawn-hand.mjs command + descriptor {F,T}
//         gate-state fidelity_pass: ['F/T']
// When:   decide()
// Then:   allow (verdict.allow === true, no deny)
// ---------------------------------------------------------------------------

test(
  "FIDELITY-2: spawn-hand.mjs + descriptor {F,T} + fidelity_pass=[F/T] → allow; fidelity_pass=[WRONG/T] → deny (qualified-id match, not blanket allow)",
  () => {
    const command =
      "node .claude/skills/orchestrating-delivery/references/spawn-hand.mjs --descriptor d.json";
    const readDescriptorFn = () => ({ feature_id: "F", task_id: "T" });

    // Matching qualified id → allow
    const allowVerdict = decide(makeBashPayload("ses_fid2a", command), {
      readDescriptorFn,
      readGateStateFn: () => ({ fidelity_pass: ["F/T"] }),
    });
    assert.equal(
      allowVerdict.allow,
      true,
      "spawn-hand.mjs must be allowed when fidelity_pass contains the matching qualified task id F/T",
    );

    // Non-matching qualified id → deny (proves the allow comes from id match, not a blanket permit)
    const denyVerdict = decide(makeBashPayload("ses_fid2b", command), {
      readDescriptorFn,
      readGateStateFn: () => ({ fidelity_pass: ["WRONG/T"] }),
    });
    assert.equal(
      denyVerdict.allow,
      false,
      "spawn-hand.mjs must be denied when fidelity_pass contains only a non-matching qualified id",
    );
    assert.equal(
      denyVerdict.hookSpecificOutput.permissionDecision,
      "deny",
      "permissionDecision must be 'deny' for non-matching fidelity_pass entry",
    );
  },
);

// ---------------------------------------------------------------------------
// FIDELITY-3 (Assertion 3)
//
// Given:  isHeadless()=>true
//         main-loop Agent payload subagent_type 'executor' (no agent_id)
//         valid FULL triage
//         gate-state fidelity_pass: []
// When:   decide()
// Then:   permissionDecision === 'deny' — headless executor no longer unconditional
// ---------------------------------------------------------------------------

test(
  "FIDELITY-3: headless executor + valid FULL triage + fidelity_pass=[] → deny (no longer unconditional)",
  () => {
    const sessionId = "ses_fid3";
    const payload = makeAgentPayload(sessionId, "executor");
    const readTriage = () => fullTriage(sessionId);
    const readGateStateFn = () => ({ fidelity_pass: [] });

    const verdict = decide(payload, {
      readTriage,
      readGateStateFn,
      isHeadlessFn: () => true,
    });

    assert.equal(
      verdict.allow,
      false,
      "headless executor must be denied when fidelity_pass is empty",
    );
    assert.equal(
      verdict.hookSpecificOutput.permissionDecision,
      "deny",
      "permissionDecision must be 'deny'",
    );
  },
);

// ---------------------------------------------------------------------------
// FIDELITY-4 (Assertion 4)
//
// Given:  isHeadless()=>true
//         main-loop Agent payload subagent_type 'executor' (no agent_id)
//         valid FULL triage
//         gate-state fidelity_pass: ['F/T']  (non-empty)
// When:   decide()
// Then:   verdict.allow === true
// ---------------------------------------------------------------------------

test(
  "FIDELITY-4: headless executor + valid FULL triage + fidelity_pass=[F/T] → allow; fidelity_pass=[WRONG/T] → deny (qualified-id match required, not just non-empty)",
  () => {
    const readTriage = () => fullTriage("ses_fid4");

    // Matching qualified id → allow
    const allowVerdict = decide(makeAgentPayload("ses_fid4a", "executor"), {
      readTriage,
      readGateStateFn: () => ({ fidelity_pass: ["F/T"] }),
      isHeadlessFn: () => true,
    });
    assert.equal(
      allowVerdict.allow,
      true,
      "headless executor must be allowed when fidelity_pass contains the matching qualified id F/T",
    );

    // Non-matching qualified id → deny (proves the check uses id matching, not just length > 0)
    const denyVerdict = decide(makeAgentPayload("ses_fid4b", "executor"), {
      readTriage,
      readGateStateFn: () => ({ fidelity_pass: ["WRONG/T"] }),
      isHeadlessFn: () => true,
    });
    assert.equal(
      denyVerdict.allow,
      false,
      "headless executor must be denied when fidelity_pass contains only a non-matching qualified id",
    );
    assert.equal(
      denyVerdict.hookSpecificOutput.permissionDecision,
      "deny",
      "permissionDecision must be 'deny' for non-matching fidelity_pass entry",
    );
  },
);

// ---------------------------------------------------------------------------
// FIDELITY-5 (Assertion 5)
//
// Given:  isHeadless()=>true
//         gate-state fidelity_pass: []
// When:   decide() for main-loop Agent(test-author) — producer
//   AND   decide() for main-loop Agent(sniper)      — post-gate fixer
// Then:   verdict.allow === true for BOTH
//         (the fidelity rail only gates executor; producer + fixer are never blocked)
// ---------------------------------------------------------------------------

test(
  "FIDELITY-5: headless test-author and sniper + fidelity_pass=[] → both allow; headless executor + same fidelity_pass=[] → deny (exemption is role-specific)",
  () => {
    const sessionId = "ses_fid5";
    const readTriage = () => fullTriage(sessionId);
    const readGateStateFn = () => ({ fidelity_pass: [] });
    const deps = { readTriage, readGateStateFn, isHeadlessFn: () => true };

    // test-author is the producer of the fidelity marker — must never be blocked by its own rail
    const taVerdict = decide(makeAgentPayload(sessionId, "test-author"), deps);
    assert.equal(
      taVerdict.allow,
      true,
      "headless test-author (fidelity producer) must allow even with empty fidelity_pass",
    );

    // sniper is the post-gate fixer — must never be blocked by the fidelity rail
    const sniperVerdict = decide(makeAgentPayload(sessionId, "sniper"), deps);
    assert.equal(
      sniperVerdict.allow,
      true,
      "headless sniper (post-gate fixer) must allow even with empty fidelity_pass",
    );

    // Contrast: executor with the SAME deps (fidelity_pass=[]) → deny.
    // This proves the exemption is role-specific — not "all headless hand-roles are free".
    const execVerdict = decide(makeAgentPayload(sessionId, "executor"), deps);
    assert.equal(
      execVerdict.allow,
      false,
      "headless executor must be denied with the same empty fidelity_pass that allows test-author and sniper",
    );
  },
);

// ---------------------------------------------------------------------------
// FIDELITY-6 (Assertion 6)
//
// Given:  PostToolUse(Bash) payload whose command contains 'mark.mjs fidelity-pass'
//         and tool_response stdout JSON line is
//           {"marker":"fidelity-pass","feature_id":"F","task_id":"T"}
// When:   stamp-triage handle() in an isolated cwd
// Then:   gate-state.json has fidelity_pass array including 'F/T'
// ---------------------------------------------------------------------------

test(
  "FIDELITY-6: fidelity-pass PostToolUse marker → handle() writes fidelity_pass=[F/T] in gate-state.json",
  () => {
    withTempDir(() => {
      const payload = makeFidelityPassPayload("ses_fid6", "F", "T");
      handle(payload);

      const gateStatePath = ".claude/plans/.state/ses_fid6/gate-state.json";
      assert.ok(
        fs.existsSync(gateStatePath),
        "gate-state.json must exist after fidelity-pass stamp",
      );

      const state = JSON.parse(fs.readFileSync(gateStatePath, "utf8"));
      assert.ok(
        Array.isArray(state.fidelity_pass),
        "fidelity_pass must be an array in gate-state.json",
      );
      assert.ok(
        state.fidelity_pass.includes("F/T"),
        `fidelity_pass must contain 'F/T' — got: ${JSON.stringify(state.fidelity_pass)}`,
      );
    });
  },
);

// ---------------------------------------------------------------------------
// FIDELITY-7 (Assertion 7)
//
// Given:  argv ['node','mark.mjs','fidelity-pass','--feature-id','F','--task-id','T']
// When:   parseArgs() then run()
// Then:   { success: true, output: { marker: 'fidelity-pass', feature_id: 'F', task_id: 'T' } }
//
// AND:
// Given:  same command but missing --task-id
// When:   parseArgs()
// Then:   null  (task_id is required for fidelity-pass)
// ---------------------------------------------------------------------------

test(
  "FIDELITY-7: mark.mjs fidelity-pass parseArgs+run → success with correct output; missing --task-id → null",
  () => {
    // Valid case — all required flags present
    const argv = ["node", "mark.mjs", "fidelity-pass", "--feature-id", "F", "--task-id", "T"];
    const parsed = parseArgs(argv);
    assert.notEqual(parsed, null, "parseArgs must return non-null for valid fidelity-pass args");
    assert.deepEqual(
      parsed,
      { marker: "fidelity-pass", feature_id: "F", task_id: "T" },
      "parseArgs must return the correct marker shape",
    );

    const result = run(parsed);
    assert.equal(result.success, true, "run must succeed for valid fidelity-pass args");
    assert.deepEqual(
      result.output,
      { marker: "fidelity-pass", feature_id: "F", task_id: "T" },
      "run output must include marker, feature_id, and task_id",
    );

    // Missing --task-id: fidelity-pass is task-scoped so task_id is required
    const argvNoTask = ["node", "mark.mjs", "fidelity-pass", "--feature-id", "F"];
    const parsedNoTask = parseArgs(argvNoTask);
    assert.equal(
      parsedNoTask,
      null,
      "parseArgs must return null when --task-id is missing for fidelity-pass",
    );
  },
);
