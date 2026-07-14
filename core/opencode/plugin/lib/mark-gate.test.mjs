/**
 * @description Locked tests for mark-gate ceremony + fidelity + array-writer stamps.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  fidelityPassEntry,
  stampFidelityPass,
  stampBrainstormed,
  stampAdversaryFired,
  stampDualStatus,
  stampRegatePending,
  stampRegatePassed,
  stampHandFinished,
  stampCaptureVerified,
} from "./mark-gate.mjs";
import { mergeGateState, readGateState } from "./gate-state.mjs";
import {
  gateStatePath,
  handRecordPath,
} from "../../../shared/lib/path-helpers.mjs";

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

test("stamp brainstormed sets true idempotent", async () => {
  await withTempProject(async ({ projectRoot, sessionId, statePath }) => {
    const r1 = stampBrainstormed({ projectRoot, sessionId });
    assert.equal(r1.ok, true, JSON.stringify(r1));
    assert.equal(r1.state.brainstormed, true);

    const r2 = stampBrainstormed({ projectRoot, sessionId });
    assert.equal(r2.ok, true, JSON.stringify(r2));
    assert.equal(r2.state.brainstormed, true);

    const disk = readGateState(statePath);
    assert.equal(disk.brainstormed, true);
  });
});

test("stamp adversary_fired keeps brainstormed", async () => {
  await withTempProject(async ({ projectRoot, sessionId, statePath }) => {
    const b = stampBrainstormed({ projectRoot, sessionId });
    assert.equal(b.ok, true);

    const a = stampAdversaryFired({ projectRoot, sessionId });
    assert.equal(a.ok, true, JSON.stringify(a));
    assert.equal(a.state.adversary_fired, true);
    assert.equal(a.state.brainstormed, true);

    const disk = readGateState(statePath);
    assert.equal(disk.brainstormed, true);
    assert.equal(disk.adversary_fired, true);
  });
});

test("stampFidelityPass adds feature/task entry", async () => {
  await withTempProject(async ({ projectRoot, sessionId, statePath }) => {
    const r = stampFidelityPass({
      projectRoot,
      sessionId,
      featureId: "oc-hooks-parity",
      taskId: "ceremony-stamp-surface",
      sha: null,
      headSha: () => null,
    });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.entry, "oc-hooks-parity/ceremony-stamp-surface");

    const disk = readGateState(statePath);
    assert.ok(disk.fidelity_pass.includes("oc-hooks-parity/ceremony-stamp-surface"));
  });
});

test("invalid dual_status free string rejected (ok:false)", async () => {
  await withTempProject(async ({ projectRoot, sessionId, statePath }) => {
    const r = stampDualStatus({
      projectRoot,
      sessionId,
      dualStatus: "completed",
    });
    assert.equal(r.ok, false);
    assert.match(String(r.reason), /invalid dual_status|enum/i);

    const disk = readGateState(statePath);
    assert.equal(disk.dual_status, undefined);
  });
});

/**
 * @description Count JSON files under OC hand-records tree.
 * @param {string} projectRoot
 * @returns {number}
 */
function countHandRecordFiles(projectRoot) {
  const root = path.join(
    projectRoot,
    ".opencode",
    "plans",
    ".state",
    "hand-records",
  );
  if (!fs.existsSync(root)) return 0;
  let n = 0;
  /** @param {string} dir */
  function walk(dir) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.isFile() && ent.name.endsWith(".json")) n += 1;
    }
  }
  walk(root);
  return n;
}

/**
 * @description Write a DONE hand-record at OC path.
 * @param {{ projectRoot: string, sessionId: string, featureId: string, taskId: string, extra?: Record<string, unknown> }} args
 * @returns {string} path
 */
function writeDoneHandRecord({
  projectRoot,
  sessionId,
  featureId,
  taskId,
  extra = {},
}) {
  const hr = handRecordPath(
    { projectRoot, runtime: "opencode", sessionId, featureId },
    taskId,
  );
  assert.equal(hr.ok, true);
  fs.mkdirSync(path.dirname(hr.path), { recursive: true });
  const record = {
    featureId,
    taskId,
    sessionId,
    outcome: "DONE",
    otherField: "keep-me",
    ...extra,
  };
  fs.writeFileSync(hr.path, JSON.stringify(record, null, 2), "utf8");
  return hr.path;
}

// --- D8a array writers (locked) ---

test("LOCKED 1: capture-verified without hand-record file → ok:false, capture_verified unchanged, zero new files", async () => {
  await withTempProject(async ({ projectRoot, sessionId, statePath }) => {
    mergeGateState(statePath, {
      hand_finished: ["feat-a/task-1"],
      capture_verified: ["other/t0@abc"],
    });
    const before = countHandRecordFiles(projectRoot);
    assert.equal(before, 0);

    const r = stampCaptureVerified({
      projectRoot,
      sessionId,
      featureId: "feat-a",
      taskId: "task-1",
      sha: "deadbeef",
      headSha: () => {
        throw new Error("must not call headSha when sha provided");
      },
    });
    assert.equal(r.ok, false, JSON.stringify(r));

    const disk = readGateState(statePath);
    assert.deepEqual(disk.capture_verified, ["other/t0@abc"]);
    assert.equal(countHandRecordFiles(projectRoot), 0);
  });
});

test("LOCKED 2: capture-verified without hand_finished → ok:false, no append", async () => {
  await withTempProject(async ({ projectRoot, sessionId, statePath }) => {
    writeDoneHandRecord({
      projectRoot,
      sessionId,
      featureId: "feat-a",
      taskId: "task-1",
    });
    mergeGateState(statePath, { capture_verified: ["keep/me@sha"] });

    const r = stampCaptureVerified({
      projectRoot,
      sessionId,
      featureId: "feat-a",
      taskId: "task-1",
      sha: "deadbeef",
    });
    assert.equal(r.ok, false, JSON.stringify(r));

    const disk = readGateState(statePath);
    assert.deepEqual(disk.capture_verified, ["keep/me@sha"]);
    assert.ok(!disk.hand_finished || !disk.hand_finished.includes("feat-a/task-1"));
  });
});

test("LOCKED 3: capture-verified happy path → capture_verified includes feature/task@sha (idempotent)", async () => {
  await withTempProject(async ({ projectRoot, sessionId, statePath }) => {
    mergeGateState(statePath, { hand_finished: ["feat-a/task-1"] });
    writeDoneHandRecord({
      projectRoot,
      sessionId,
      featureId: "feat-a",
      taskId: "task-1",
    });

    const r1 = stampCaptureVerified({
      projectRoot,
      sessionId,
      featureId: "feat-a",
      taskId: "task-1",
      sha: "deadbeef",
    });
    assert.equal(r1.ok, true, JSON.stringify(r1));
    assert.equal(r1.entry, "feat-a/task-1@deadbeef");

    const r2 = stampCaptureVerified({
      projectRoot,
      sessionId,
      featureId: "feat-a",
      taskId: "task-1",
      sha: "deadbeef",
    });
    assert.equal(r2.ok, true, JSON.stringify(r2));

    const disk = readGateState(statePath);
    assert.ok(disk.capture_verified.includes("feat-a/task-1@deadbeef"));
    assert.equal(
      disk.capture_verified.filter((e) => e === "feat-a/task-1@deadbeef")
        .length,
      1,
    );
  });
});

test("LOCKED 4: capture-verified happy path → DONE record gains non-empty ISO capturedVerifiedAt, other fields preserved", async () => {
  await withTempProject(async ({ projectRoot, sessionId }) => {
    const recordPath = writeDoneHandRecord({
      projectRoot,
      sessionId,
      featureId: "feat-a",
      taskId: "task-1",
      extra: { otherField: "keep-me", freezeCommitSha: "abc" },
    });
    stampHandFinished({
      projectRoot,
      sessionId,
      featureId: "feat-a",
      taskId: "task-1",
    });

    const r = stampCaptureVerified({
      projectRoot,
      sessionId,
      featureId: "feat-a",
      taskId: "task-1",
      sha: "deadbeef",
    });
    assert.equal(r.ok, true, JSON.stringify(r));

    const updated = JSON.parse(fs.readFileSync(recordPath, "utf8"));
    assert.equal(typeof updated.capturedVerifiedAt, "string");
    assert.ok(updated.capturedVerifiedAt.length > 0);
    assert.equal(updated.otherField, "keep-me");
    assert.equal(updated.freezeCommitSha, "abc");
    assert.equal(updated.outcome, "DONE");
  });
});

test("LOCKED 5: capture-verified on FAILED record → ok:false, no stamp", async () => {
  await withTempProject(async ({ projectRoot, sessionId, statePath }) => {
    mergeGateState(statePath, {
      hand_finished: ["feat-a/task-1"],
      capture_verified: [],
    });
    const hr = handRecordPath(
      {
        projectRoot,
        runtime: "opencode",
        sessionId,
        featureId: "feat-a",
      },
      "task-1",
    );
    assert.equal(hr.ok, true);
    fs.mkdirSync(path.dirname(hr.path), { recursive: true });
    fs.writeFileSync(
      hr.path,
      JSON.stringify({
        featureId: "feat-a",
        taskId: "task-1",
        outcome: "FAILED",
        otherField: "x",
      }),
      "utf8",
    );

    const r = stampCaptureVerified({
      projectRoot,
      sessionId,
      featureId: "feat-a",
      taskId: "task-1",
      sha: "deadbeef",
    });
    assert.equal(r.ok, false, JSON.stringify(r));

    const disk = readGateState(statePath);
    assert.ok(!disk.capture_verified.includes("feat-a/task-1@deadbeef"));
    const rec = JSON.parse(fs.readFileSync(hr.path, "utf8"));
    assert.equal(rec.capturedVerifiedAt, undefined);
    assert.equal(rec.outcome, "FAILED");
  });
});

test("LOCKED 6: regate-passed without sha → ok:false, never unqualified entry", async () => {
  await withTempProject(async ({ projectRoot, sessionId, statePath }) => {
    const r = stampRegatePassed({
      projectRoot,
      sessionId,
      featureId: "feat-a",
      taskId: "task-1",
      sha: null,
      headSha: () => null,
    });
    assert.equal(r.ok, false, JSON.stringify(r));

    const disk = readGateState(statePath);
    const passed = Array.isArray(disk.regate_passed) ? disk.regate_passed : [];
    assert.ok(!passed.includes("feat-a/task-1"));
    assert.equal(passed.length, 0);
  });
});

test("LOCKED 7: regate-passed with sha → entry feature/task@sha", async () => {
  await withTempProject(async ({ projectRoot, sessionId, statePath }) => {
    const r = stampRegatePassed({
      projectRoot,
      sessionId,
      featureId: "feat-a",
      taskId: "task-1",
      sha: "cafebabe",
      headSha: () => {
        throw new Error("must not call headSha when sha provided");
      },
    });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.entry, "feat-a/task-1@cafebabe");

    const disk = readGateState(statePath);
    assert.ok(disk.regate_passed.includes("feat-a/task-1@cafebabe"));
  });
});

test("LOCKED 8: regate-pending / hand-finished → feature/task form, union idempotent", async () => {
  await withTempProject(async ({ projectRoot, sessionId, statePath }) => {
    mergeGateState(statePath, {
      regate_pending: ["other/t0"],
      hand_finished: ["other/t0"],
    });

    const p1 = stampRegatePending({
      projectRoot,
      sessionId,
      featureId: "feat-a",
      taskId: "task-1",
    });
    assert.equal(p1.ok, true, JSON.stringify(p1));
    assert.equal(p1.entry, "feat-a/task-1");
    const p2 = stampRegatePending({
      projectRoot,
      sessionId,
      featureId: "feat-a",
      taskId: "task-1",
    });
    assert.equal(p2.ok, true);

    const h1 = stampHandFinished({
      projectRoot,
      sessionId,
      featureId: "feat-a",
      taskId: "task-1",
    });
    assert.equal(h1.ok, true, JSON.stringify(h1));
    assert.equal(h1.entry, "feat-a/task-1");
    const h2 = stampHandFinished({
      projectRoot,
      sessionId,
      featureId: "feat-a",
      taskId: "task-1",
    });
    assert.equal(h2.ok, true);

    const disk = readGateState(statePath);
    assert.ok(disk.regate_pending.includes("other/t0"));
    assert.ok(disk.regate_pending.includes("feat-a/task-1"));
    assert.equal(
      disk.regate_pending.filter((e) => e === "feat-a/task-1").length,
      1,
    );
    assert.ok(disk.hand_finished.includes("other/t0"));
    assert.ok(disk.hand_finished.includes("feat-a/task-1"));
    assert.equal(
      disk.hand_finished.filter((e) => e === "feat-a/task-1").length,
      1,
    );
  });
});

test("stampHandFinished emits hand-ran to outbox when HARNESS_OBSERVABILITY_RUN_PATH set", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hand-obs-"));
  try {
    const meta = path.join(dir, "obs.json");
    fs.writeFileSync(meta, "{}");
    process.env.HARNESS_OBSERVABILITY_RUN_PATH = meta;
    const sessionId = "ses_hand1";
    const r = stampHandFinished({
      projectRoot: dir,
      sessionId,
      featureId: "f1",
      taskId: "task-9",
      model: "gpt-5.6-terra",
    });
    assert.equal(r.ok, true);
    const raw = fs.readFileSync(path.join(dir, "obs.events.jsonl"), "utf8");
    assert.ok(raw.includes("hand-ran"), raw);
    assert.ok(raw.includes("task-9"), raw);
    assert.ok(raw.includes("gpt-5.6-terra"), raw);
  } finally {
    delete process.env.HARNESS_OBSERVABILITY_RUN_PATH;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
