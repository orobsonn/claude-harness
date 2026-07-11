/**
 * @description Locked tests for stampFidelityPass (fidelity-rail producer).
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  fidelityPassEntry,
  stampFidelityPass,
} from "./mark-gate.mjs";
import { mergeGateState, readGateState } from "./gate-state.mjs";
import { gateStatePath } from "../../../shared/lib/path-helpers.mjs";

/**
 * @param {(ctx: { projectRoot: string, sessionId: string, statePath: string }) => void | Promise<void>} fn
 */
async function withTempProject(fn) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mark-gate-"));
  const sessionId = "ses_markgate1";
  try {
    const gp = gateStatePath({
      projectRoot,
      runtime: "opencode",
      sessionId,
    });
    assert.equal(gp.ok, true);
    fs.mkdirSync(path.dirname(gp.path), { recursive: true });
    await fn({ projectRoot, sessionId, statePath: gp.path });
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
}

test("fidelityPassEntry: bare and sha-qualified forms", () => {
  assert.equal(fidelityPassEntry("feat-a", "task-1", null), "feat-a/task-1");
  assert.equal(fidelityPassEntry("feat-a", "task-1", undefined), "feat-a/task-1");
  assert.equal(fidelityPassEntry("feat-a", "task-1", ""), "feat-a/task-1");
  assert.equal(
    fidelityPassEntry("feat-a", "task-1", "abc123"),
    "feat-a/task-1@abc123",
  );
});

test("stampFidelityPass: writes fidelity_pass via mergeGateState (sha-qualified when sha given)", async () => {
  await withTempProject(async ({ projectRoot, sessionId, statePath }) => {
    const r = stampFidelityPass({
      projectRoot,
      sessionId,
      featureId: "feat-a",
      taskId: "task-1",
      sha: "deadbeef",
      headSha: () => {
        throw new Error("must not call headSha when sha provided");
      },
    });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.entry, "feat-a/task-1@deadbeef");

    const disk = readGateState(statePath);
    assert.ok(Array.isArray(disk.fidelity_pass));
    assert.ok(disk.fidelity_pass.includes("feat-a/task-1@deadbeef"));
  });
});

test("stampFidelityPass: idempotent union — second stamp does not drop prior markers", async () => {
  await withTempProject(async ({ projectRoot, sessionId, statePath }) => {
    mergeGateState(statePath, { fidelity_pass: ["other/t0"], hand_finished: ["other/t0"] });

    const r1 = stampFidelityPass({
      projectRoot,
      sessionId,
      featureId: "feat-a",
      taskId: "task-1",
      sha: null,
      headSha: () => null,
    });
    assert.equal(r1.ok, true);

    const r2 = stampFidelityPass({
      projectRoot,
      sessionId,
      featureId: "feat-a",
      taskId: "task-1",
      sha: null,
      headSha: () => null,
    });
    assert.equal(r2.ok, true);

    const disk = readGateState(statePath);
    assert.ok(disk.fidelity_pass.includes("other/t0"));
    assert.ok(disk.fidelity_pass.includes("feat-a/task-1"));
    assert.ok(disk.hand_finished.includes("other/t0"));
  });
});

test("stampFidelityPass: missing required ids → ok:false", () => {
  const r = stampFidelityPass({
    projectRoot: "/tmp",
    sessionId: "ses_x",
    featureId: "",
    taskId: "t1",
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /required/i);
});
