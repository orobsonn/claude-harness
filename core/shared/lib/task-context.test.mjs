import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

import {
  TASK_CONTEXT_MAX_BYTES,
  buildTaskContextHandoff,
  buildTaskContextReturn,
  readBoundedRegularFile,
  validateTaskContextHandoff,
  validateTaskContextReturn,
} from "./task-context.mjs";

const sha = (text) => createHash("sha256").update(text).digest("hex");
const HEAD = "a".repeat(40);
const handoff = (content, shared = null) => buildTaskContextHandoff({
  parentSessionId: "parent-1", taskId: "task-a", content, readSharedContext: () => shared,
});

test("curated context accepts exactly 2048 UTF-8 bytes, multibyte included, and rejects one more", () => {
  assert.equal(TASK_CONTEXT_MAX_BYTES, 2048);
  const twoByte = "é".repeat(1024); // 2048 bytes, 1024 code units
  assert.equal(Buffer.byteLength(twoByte, "utf8"), 2048);
  assert.equal(handoff(twoByte).content, twoByte);
  assert.throws(() => handoff(`${twoByte}x`), /at most 2048 UTF-8 bytes/);
  // 682 three-byte chars = 2046 bytes; one more 3-byte char crosses the limit at 2049.
  const threeByte = "€".repeat(682);
  assert.equal(handoff(`${threeByte}ab`).content.length, 684);
  assert.throws(() => handoff(`${threeByte}€`), /at most 2048 UTF-8 bytes/);
  assert.throws(() => handoff("   "), /non-empty string/);
  assert.throws(() => handoff(42), /non-empty string/);
});

test("handoff binds parent diary revision and is read lazily only after validation", () => {
  let reads = 0;
  assert.throws(() => buildTaskContextHandoff({
    parentSessionId: "../evil", taskId: "task-a", content: "x", readSharedContext: () => { reads += 1; return null; },
  }), /valid parent session and task identity/);
  assert.throws(() => buildTaskContextHandoff({
    parentSessionId: "parent-1", taskId: "task-a", content: "x".repeat(3000), readSharedContext: () => { reads += 1; return null; },
  }), /2048/);
  assert.equal(reads, 0);
  const snapshot = handoff("brief", "diary");
  assert.deepEqual(snapshot, {
    version: 1, kind: "curated-task-context", parent_session_id: "parent-1", task_id: "task-a",
    source_shared_context_sha256: sha("diary"), content_sha256: sha("brief"), content: "brief",
  });
  assert.equal(handoff("brief").source_shared_context_sha256, null);
});

test("handoff validation requires exact keys, identity and content hash", () => {
  const snapshot = handoff("brief", "diary");
  const ok = validateTaskContextHandoff(snapshot, { parentSessionId: "parent-1", taskId: "task-a" });
  assert.equal(ok.ok, true);
  assert.notEqual(ok.snapshot, snapshot);
  assert.match(validateTaskContextHandoff({ ...snapshot, extra: 1 }, { parentSessionId: "parent-1", taskId: "task-a" }).reason, /shape mismatch/);
  const { content_sha256: _omit, ...missing } = snapshot;
  assert.match(validateTaskContextHandoff(missing, { parentSessionId: "parent-1", taskId: "task-a" }).reason, /shape mismatch/);
  assert.match(validateTaskContextHandoff(snapshot, { parentSessionId: "parent-1", taskId: "task-b" }).reason, /identity mismatch/);
  assert.match(validateTaskContextHandoff({ ...snapshot, content: "forged" }, { parentSessionId: "parent-1", taskId: "task-a" }).reason, /hash or byte limit/);
});

test("context return is bound to session, task and exact HEAD, with a host-chosen byte ceiling", () => {
  const value = buildTaskContextReturn({ sessionId: "child-1", taskId: "task-a", headSha: HEAD, content: "learned" });
  assert.deepEqual(value, {
    version: 1, kind: "task-context-return", session_id: "child-1", task_id: "task-a",
    head_sha: HEAD, content: "learned", sha256: sha("learned"),
  });
  const expect = { sessionId: "child-1", taskId: "task-a", headSha: HEAD };
  assert.equal(validateTaskContextReturn(value, expect).ok, true);
  assert.match(validateTaskContextReturn({ ...value, content: "forged" }, expect).reason, /hash or byte limit/);
  assert.match(validateTaskContextReturn({ ...value, content: "forged", sha256: sha("forged") }, { ...expect, headSha: "b".repeat(40) }).reason, /identity mismatch/);
  assert.match(validateTaskContextReturn(value, { ...expect, sessionId: "child-2" }).reason, /identity mismatch/);
  assert.match(validateTaskContextReturn(value, { ...expect, maxBytes: 3 }).reason, /byte limit/);
  assert.throws(() => buildTaskContextReturn({ ...expect, content: "x".repeat(10), maxBytes: 4 }), /byte limit/);
});

test("bounded state reads refuse symlinks, aliases and oversize files", () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "task-context-")));
  const file = path.join(dir, "state.json");
  fs.writeFileSync(file, "{}");
  assert.equal(readBoundedRegularFile(file, 16), "{}");
  const link = path.join(dir, "link.json");
  fs.symlinkSync(file, link);
  assert.throws(() => readBoundedRegularFile(link, 16), /unsafe task state file/);
  fs.writeFileSync(file, "x".repeat(32));
  assert.throws(() => readBoundedRegularFile(file, 16), /unsafe task state file/);
  assert.throws(() => readBoundedRegularFile(path.join(dir, ".", "state.json").replace(dir, `${dir}/../${path.basename(dir)}`), 64), /unsafe task state file/);
});
