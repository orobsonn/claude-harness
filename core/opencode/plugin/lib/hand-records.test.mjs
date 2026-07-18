/** @description Locked tests for hand-records list/write/parse helpers. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  listHandRecordsForFeature,
  writeHandRecord,
  parseHandStatusFromOutput,
  buildTaskHandRecord,
} from "./hand-records.mjs";
import { handRecordPath } from "../../../shared/lib/path-helpers.mjs";

/**
 * @param {(projectRoot: string) => void | Promise<void>} fn
 */
async function withTempProject(fn) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "oc-hand-records-"));
  try {
    await fn(projectRoot);
  } finally {
    try {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

/**
 * @param {string} projectRoot
 * @param {string} featureId
 * @param {string} sessionId
 * @param {string} taskId
 * @param {object} record
 */
function seedHandRecord(projectRoot, featureId, sessionId, taskId, record) {
  const resolved = handRecordPath(
    { projectRoot, runtime: "opencode", featureId, sessionId },
    taskId
  );
  assert.equal(resolved.ok, true);
  fs.mkdirSync(path.dirname(resolved.path), { recursive: true });
  fs.writeFileSync(resolved.path, JSON.stringify(record), "utf8");
}

test("feature F with DONE under session A — list includes session-A record even if ship is B", async () => {
  await withTempProject((projectRoot) => {
    const featureId = "feat-f";
    seedHandRecord(projectRoot, featureId, "session-a", "task-1", {
      outcome: "DONE",
      freezeCommitSha: "abc123",
    });
    seedHandRecord(projectRoot, featureId, "session-b", "task-ship", {
      outcome: "DONE",
      freezeCommitSha: "def456",
    });

    const listed = listHandRecordsForFeature(projectRoot, featureId);
    const sessionA = listed.find((r) => r.sessionId === "session-a");
    assert.ok(sessionA, "must include session-a record even when ship is session-b");
    assert.equal(sessionA.taskId, "task-1");
    assert.equal(sessionA.record.outcome, "DONE");
    assert.ok(listed.some((r) => r.sessionId === "session-b" && r.taskId === "task-ship"));
  });
});

test("unsafe featureId '../../../tmp' → []", async () => {
  await withTempProject((projectRoot) => {
    assert.deepEqual(listHandRecordsForFeature(projectRoot, "../../../tmp"), []);
  });
});

test("missing dir → [] without throw", async () => {
  await withTempProject((projectRoot) => {
    assert.doesNotThrow(() => {
      const listed = listHandRecordsForFeature(projectRoot, "no-such-feature");
      assert.deepEqual(listed, []);
    });
  });
});

test("two session dirs each with one task json → both taskIds appear", async () => {
  await withTempProject((projectRoot) => {
    const featureId = "feat-two";
    seedHandRecord(projectRoot, featureId, "ses-1", "task-alpha", { outcome: "DONE" });
    seedHandRecord(projectRoot, featureId, "ses-2", "task-beta", { outcome: "DONE" });

    const listed = listHandRecordsForFeature(projectRoot, featureId);
    const taskIds = listed.map((r) => r.taskId).sort();
    assert.deepEqual(taskIds, ["task-alpha", "task-beta"]);
    assert.equal(listed.length, 2);
  });
});

test("writeHandRecord creates file at handRecordPath", async () => {
  await withTempProject((projectRoot) => {
    const roots = {
      projectRoot,
      runtime: "opencode",
      sessionId: "ses_write1",
      featureId: "feat-write",
    };
    const record = { outcome: "DONE", writtenBy: "test" };
    const w = writeHandRecord({ roots, taskId: "task-1", record });
    assert.equal(w.ok, true);
    const expected = handRecordPath(roots, "task-1");
    assert.equal(expected.ok, true);
    assert.equal(w.path, expected.path);
    assert.ok(fs.existsSync(w.path));
    const disk = JSON.parse(fs.readFileSync(w.path, "utf8"));
    assert.equal(disk.outcome, "DONE");
  });
});

test("writeHandRecord invalid featureId → ok false without throw", async () => {
  await withTempProject((projectRoot) => {
    const w = writeHandRecord({
      roots: {
        projectRoot,
        runtime: "opencode",
        sessionId: "ses_x",
        featureId: "../../../etc",
      },
      taskId: "task-1",
      record: { outcome: "DONE" },
    });
    assert.equal(w.ok, false);
  });
});

test("parseHandStatusFromOutput: DONE / DONE_WITH_CONCERNS / missing / last wins", () => {
  assert.equal(parseHandStatusFromOutput("Status: DONE\n"), "DONE");
  assert.equal(parseHandStatusFromOutput("Status: DONE_WITH_CONCERNS"), "DONE_WITH_CONCERNS");
  assert.equal(parseHandStatusFromOutput("Status: NEEDS_CONTEXT"), "NEEDS_CONTEXT");
  assert.equal(parseHandStatusFromOutput("Status: BLOCKED"), "BLOCKED");
  assert.equal(parseHandStatusFromOutput("no status line here"), null);
  assert.equal(parseHandStatusFromOutput(""), null);
  assert.equal(parseHandStatusFromOutput(null), null);
  assert.equal(
    parseHandStatusFromOutput("Status: BLOCKED\nthen later Status: DONE\n"),
    "DONE",
  );
  assert.equal(
    parseHandStatusFromOutput("Status: DONE\nthen Status: DONE_WITH_CONCERNS"),
    "DONE_WITH_CONCERNS",
  );
  assert.equal(parseHandStatusFromOutput("status: DONE"), null);
});

test("buildTaskHandRecord shape", () => {
  const rec = buildTaskHandRecord({
    featureId: "feat-a",
    taskId: "t-1",
    sessionId: "ses_1",
    freezeCommitSha: "abc",
    outcome: "DONE",
    touchedPaths: ["src/a.ts"],
    agent: "executor-medium",
    timestamps: { startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:01:00.000Z" },
  });
  assert.equal(rec.featureId, "feat-a");
  assert.equal(rec.taskId, "t-1");
  assert.equal(rec.sessionId, "ses_1");
  assert.equal(rec.freezeCommitSha, "abc");
  assert.equal(rec.outcome, "DONE");
  assert.deepEqual(rec.touchedPaths, ["src/a.ts"]);
  assert.deepEqual(rec.scopeViolations, []);
  assert.deepEqual(rec.frozenViolations, []);
  assert.equal(rec.agent, "executor-medium");
  assert.equal(rec.writtenBy, "obs-hand-task");
  assert.equal(rec.startedAt, "2026-01-01T00:00:00.000Z");
  assert.equal(rec.finishedAt, "2026-01-01T00:01:00.000Z");
});
