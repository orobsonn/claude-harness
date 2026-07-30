/** @description Locked tests for host regate-pending auto-arm helper (#377). */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  isRegateArmingSniperRole,
  isRegateArmingOutcome,
  armRegatePending,
} from "./regate-arm.mjs";
import { fidelityPassEntry } from "./mark-gate.mjs";
import { decideBashDelivery } from "./bash-decide.mjs";

const SESSION = "ses_regate_arm";
const FEATURE = "feat-regate";
const TASK = "task-high";

/**
 * @description Temp project with seeded gate-state identity (no unsigned privileged markers).
 * @param {Record<string, unknown>} [extra]
 */
function withSeededRoot(extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "regate-arm-"));
  const stateDir = path.join(root, ".opencode", "plans", ".state", SESSION);
  fs.mkdirSync(stateDir, { recursive: true });
  const statePath = path.join(stateDir, "gate-state.json");
  const state = {
    session_id: SESSION,
    feature_id: FEATURE,
    ...extra,
  };
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  return { root, statePath, close: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test("isRegateArmingSniperRole: high/medium (+spawn) only", () => {
  assert.equal(isRegateArmingSniperRole("sniper-high"), true);
  assert.equal(isRegateArmingSniperRole("sniper-high-spawn"), true);
  assert.equal(isRegateArmingSniperRole("sniper-medium"), true);
  assert.equal(isRegateArmingSniperRole("Sniper-Medium-Spawn"), true);
  assert.equal(isRegateArmingSniperRole("sniper-low"), false);
  assert.equal(isRegateArmingSniperRole("executor-high"), false);
  assert.equal(isRegateArmingSniperRole("adversary-family-1"), false);
  assert.equal(isRegateArmingSniperRole(""), false);
  assert.equal(isRegateArmingSniperRole(null), false);
});

test("isRegateArmingOutcome: DONE only", () => {
  assert.equal(isRegateArmingOutcome("DONE"), true);
  assert.equal(isRegateArmingOutcome("DONE_WITH_CONCERNS"), false);
  assert.equal(isRegateArmingOutcome("BLOCKED"), false);
  assert.equal(isRegateArmingOutcome(null), false);
});

test("armRegatePending: writes regate_pending feature/task", () => {
  const f = withSeededRoot();
  try {
    const result = armRegatePending({
      projectRoot: f.root,
      sessionId: SESSION,
      featureId: FEATURE,
      taskId: TASK,
    });
    assert.equal(result.ok, true, result.reason);
    const expected = fidelityPassEntry(FEATURE, TASK, null);
    assert.equal(result.entry, expected);
    assert.ok(Array.isArray(result.state.regate_pending));
    assert.ok(result.state.regate_pending.includes(expected));

    const disk = JSON.parse(fs.readFileSync(f.statePath, "utf8"));
    assert.ok(disk.regate_pending.includes(expected));
  } finally {
    f.close();
  }
});

test("armRegatePending: idempotent union", () => {
  const f = withSeededRoot();
  try {
    const first = armRegatePending({
      projectRoot: f.root,
      sessionId: SESSION,
      featureId: FEATURE,
      taskId: TASK,
    });
    assert.equal(first.ok, true, first.reason);
    const second = armRegatePending({
      projectRoot: f.root,
      sessionId: SESSION,
      featureId: FEATURE,
      taskId: TASK,
    });
    assert.equal(second.ok, true, second.reason);
    const expected = fidelityPassEntry(FEATURE, TASK, null);
    assert.deepEqual(
      second.state.regate_pending.filter((e) => e === expected),
      [expected],
    );
  } finally {
    f.close();
  }
});

test("armRegatePending: identity mismatch → deny", () => {
  const f = withSeededRoot();
  try {
    const result = armRegatePending({
      projectRoot: f.root,
      sessionId: SESSION,
      featureId: "other-feature",
      taskId: TASK,
    });
    assert.equal(result.ok, false);
    assert.match(String(result.reason), /identity/i);
  } finally {
    f.close();
  }
});

test("#ac-1.2: armRegatePending then bash-decide git push → deny unmatched", () => {
  const f = withSeededRoot({
    classified: true,
    mode: "FULL",
    // #404 made planner_status=usable a precondition for LIGHT/FULL delivery; without it
    // that guard denies first and this fixture never reaches the re-gate check under test.
    planner_status: "usable",
    brainstormed: true,
    adversary_fired: true,
    dual_status: "done",
  });
  try {
    const armed = armRegatePending({
      projectRoot: f.root,
      sessionId: SESSION,
      featureId: FEATURE,
      taskId: TASK,
    });
    assert.equal(armed.ok, true, armed.reason);
    const disk = JSON.parse(fs.readFileSync(f.statePath, "utf8"));
    const d = decideBashDelivery({
      command: "git push",
      gateState: disk,
      sessionId: SESSION,
      gitState: { branch: "feat/x", commitsAhead: 1, defaultBranch: "main" },
      isAncestorFn: () => true,
      listHandRecordsForFeatureFn: () => [],
    });
    assert.equal(d.decision, "deny");
    assert.match(d.reason, /regate-pending without regate-passed/);
    assert.match(d.reason, new RegExp(`${FEATURE}/${TASK}`));
  } finally {
    f.close();
  }
});
