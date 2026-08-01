/** @description OC-native host hand capture unit tests. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  resolveOcHandOutcome,
  hostStampOcHandCapture,
} from "./host-hand-capture.mjs";
import * as hostHandCapture from "./host-hand-capture.mjs";

test("resolveHeadSha uses only the explicit project root and fails best-effort", () => {
  assert.equal(typeof hostHandCapture.resolveHeadSha, "function");
  const calls = [];
  const execFileSyncFn = (command, args, options) => {
    calls.push({ command, args, options });
    return "  abc123deadbeef\n";
  };
  assert.equal(hostHandCapture.resolveHeadSha("/explicit/project", execFileSyncFn), "abc123deadbeef");
  assert.deepEqual(calls, [
    {
      command: "git",
      args: ["rev-parse", "HEAD"],
      options: {
        cwd: "/explicit/project",
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 5000,
      },
    },
  ]);
  assert.equal(hostHandCapture.resolveHeadSha("/explicit/project", () => " \n"), null);
  assert.equal(hostHandCapture.resolveHeadSha("/explicit/project", () => { throw new Error("no git"); }), null);
});

test("resolveOcHandOutcome promotes BLOCKED to DONE when git touched", () => {
  assert.equal(resolveOcHandOutcome("BLOCKED", ["src/a.ts"]), "DONE");
  assert.equal(resolveOcHandOutcome(null, ["src/a.ts"]), "DONE");
  assert.equal(resolveOcHandOutcome("DONE", []), "DONE");
  assert.equal(resolveOcHandOutcome("NEEDS_CONTEXT", ["x"]), "NEEDS_CONTEXT");
  assert.equal(resolveOcHandOutcome("BLOCKED", []), "BLOCKED");
});

test("hostStampOcHandCapture writes DONE record + stamps gate", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oc-host-cap-"));
  try {
    const sessionId = "ses_hostcap01";
    const featureId = "feat-cap";
    const taskId = "task-1";
    const stateDir = path.join(root, ".opencode", "plans", ".state", sessionId);
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, "gate-state.json"),
      JSON.stringify({ session_id: sessionId, feature_id: featureId, classified: true }),
    );
    // fake git HEAD via env cwd without git — pass freeze sha explicitly
    const r = hostStampOcHandCapture({
      projectRoot: root,
      sessionId,
      featureId,
      taskId,
      role: "executor-medium",
      outcome: "DONE",
      touchedPaths: ["src/policy/availability-view.ts"],
      freezeCommitSha: "abc123deadbeef",
    });
    assert.equal(r.ok, true);
    const recPath = path.join(
      root,
      ".opencode",
      "plans",
      ".state",
      "hand-records",
      featureId,
      sessionId,
      `${taskId}.json`,
    );
    const rec = JSON.parse(fs.readFileSync(recPath, "utf8"));
    assert.equal(rec.outcome, "DONE");
    assert.equal(rec.writtenBy, "obs-hand-task");
    assert.ok(rec.capturedVerifiedAt);
    const gs = JSON.parse(fs.readFileSync(path.join(stateDir, "gate-state.json"), "utf8"));
    assert.ok(gs.hand_finished?.some((x) => String(x).includes(taskId)));
    assert.ok(gs.capture_verified?.some((x) => String(x).includes(taskId)));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("re-capture at a new HEAD sha leaves no orphan capture_verified entry", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oc-host-recap-"));
  try {
    const sessionId = "ses_hostrecap01";
    const featureId = "fup-cadence-business-hours";
    const taskId = "task-1";
    const stateDir = path.join(root, ".opencode", "plans", ".state", sessionId);
    const gsPath = path.join(stateDir, "gate-state.json");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      gsPath,
      JSON.stringify({ session_id: sessionId, feature_id: featureId, classified: true }),
    );

    const shaA = "7a6fc82a12524f7619b4c7e0a813d43a2cbaf0e1";
    const shaB = "760c23ae51d26be36346ce689346282ecc8c8d6f";
    const otherTaskId = "task-10";
    const common = {
      projectRoot: root,
      sessionId,
      featureId,
      taskId,
      role: "executor-medium",
      outcome: "DONE",
      touchedPaths: ["src/x.ts"],
    };

    // Seed a sibling task ("task-10") captured at shaA in the same session. A bare
    // startsWith match (without the "@" delimiter) would treat this as belonging to
    // "task-1" and wrongly prune it when task-1 is recaptured below.
    const seedOther = hostStampOcHandCapture({
      ...common,
      taskId: otherTaskId,
      freezeCommitSha: shaA,
    });
    assert.equal(seedOther.ok, true);

    // Capture the same task twice as the repo HEAD advances within one session.
    const first = hostStampOcHandCapture({ ...common, freezeCommitSha: shaA });
    assert.equal(first.ok, true);
    const second = hostStampOcHandCapture({ ...common, freezeCommitSha: shaB });
    assert.equal(second.ok, true);

    const gs = JSON.parse(fs.readFileSync(gsPath, "utf8"));

    // Array must mirror the per-task pruning policy: exactly one entry for the task, at the latest sha.
    const taskEntries = (gs.capture_verified ?? []).filter(
      (e) => e === `${featureId}/${taskId}` || String(e).startsWith(`${featureId}/${taskId}@`),
    );
    assert.deepEqual(taskEntries, [`${featureId}/${taskId}@${shaB}`]);

    // Sibling task-10's entry must survive the task-1 recapture untouched — the "@"
    // delimiter must not let "task-1" match "task-10".
    const otherEntries = (gs.capture_verified ?? []).filter(
      (e) => e === `${featureId}/${otherTaskId}` || String(e).startsWith(`${featureId}/${otherTaskId}@`),
    );
    assert.deepEqual(otherEntries, [`${featureId}/${otherTaskId}@${shaA}`]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
