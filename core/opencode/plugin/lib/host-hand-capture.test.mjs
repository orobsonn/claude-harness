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
