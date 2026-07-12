/** @description Locked tests for listHandRecordsForFeature (all-session walk under feature). */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { listHandRecordsForFeature } from "./hand-records.mjs";
import { handRecordPath } from "../../shared/lib/path-helpers.mjs";

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
function writeHandRecord(projectRoot, featureId, sessionId, taskId, record) {
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
    writeHandRecord(projectRoot, featureId, "session-a", "task-1", {
      outcome: "DONE",
      freezeCommitSha: "abc123",
    });
    writeHandRecord(projectRoot, featureId, "session-b", "task-ship", {
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
    writeHandRecord(projectRoot, featureId, "ses-1", "task-alpha", { outcome: "DONE" });
    writeHandRecord(projectRoot, featureId, "ses-2", "task-beta", { outcome: "DONE" });

    const listed = listHandRecordsForFeature(projectRoot, featureId);
    const taskIds = listed.map((r) => r.taskId).sort();
    assert.deepEqual(taskIds, ["task-alpha", "task-beta"]);
    assert.equal(listed.length, 2);
  });
});
