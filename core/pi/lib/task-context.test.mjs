import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

import {
  captureTaskContext,
  readTaskContextReturn,
  TASK_CONTEXT_MAX_BYTES,
  validateTaskContextHandoff,
  validateTaskContextReturn,
} from "./task-context.mjs";
import { SHARED_CONTEXT_MAX_BYTES, updateSharedContext } from "./memory-cycle.mjs";

const PARENT = "global-parent";
const SESSION = "task-parent";
const TASK = "task-one";
const sha256 = (content) => createHash("sha256").update(content).digest("hex");

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-task-context-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", "-b", "task-branch"], { cwd: root });
  fs.writeFileSync(path.join(root, "product.txt"), "product\n");
  execFileSync("git", ["add", "product.txt"], { cwd: root });
  execFileSync("git", ["-c", "user.name=Harness", "-c", "user.email=harness@example.invalid", "commit", "-q", "-m", "base"], { cwd: root });
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const stateDir = path.join(root, ".pi", "harness", "state", SESSION);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, "gate-state.json"), JSON.stringify({
    session_id: SESSION,
    task_pipeline_version: 1,
    classification_source: "delegated-task",
    task_run: { task_id: TASK },
  }));
  return { root, head, stateDir };
}

test("captureTaskContext binds a curated, non-literal brief to the current parent diary revision", (t) => {
  const { root } = fixture(t);
  updateSharedContext(root, PARENT, "raw parent diary that is deliberately not copied");
  const first = captureTaskContext({ projectRoot: root, sessionId: PARENT, taskId: TASK, content: "Check the parser boundary." });
  assert.deepEqual(first, {
    version: 1,
    kind: "curated-task-context",
    parent_session_id: PARENT,
    task_id: TASK,
    source_shared_context_sha256: sha256("raw parent diary that is deliberately not copied"),
    content_sha256: sha256("Check the parser boundary."),
    content: "Check the parser boundary.",
  });

  updateSharedContext(root, PARENT, "a later parent diary revision");
  const second = captureTaskContext({ projectRoot: root, sessionId: PARENT, taskId: TASK, content: first.content });
  assert.notEqual(second.source_shared_context_sha256, first.source_shared_context_sha256);
  assert.equal(second.content_sha256, first.content_sha256);
  assert.equal(validateTaskContextHandoff(first, { parentSessionId: PARENT, taskId: TASK }).ok, true);
});

test("context handoff validation rejects mutation, foreign identity, extra authority and UTF-8 overflow", (t) => {
  const { root } = fixture(t);
  const snapshot = captureTaskContext({ projectRoot: root, sessionId: PARENT, taskId: TASK, content: "curated" });
  for (const changed of [
    { ...snapshot, content: "mutated" },
    { ...snapshot, parent_session_id: "foreign-parent" },
    { ...snapshot, task_id: "task-two" },
    { ...snapshot, gate_state: { approved: true } },
    { ...snapshot, source_shared_context_sha256: "bad" },
  ]) {
    assert.equal(validateTaskContextHandoff(changed, { parentSessionId: PARENT, taskId: TASK }).ok, false);
  }
  assert.throws(
    () => captureTaskContext({ projectRoot: root, sessionId: PARENT, taskId: TASK, content: "é".repeat((TASK_CONTEXT_MAX_BYTES / 2) + 1) }),
    /2048 UTF-8 bytes/,
  );
});

test("readTaskContextReturn returns null when absent and binds the local diary to exact task HEAD", (t) => {
  const { root, head } = fixture(t);
  assert.equal(readTaskContextReturn({ projectRoot: root, sessionId: SESSION, taskId: TASK, headSha: head }), null);

  updateSharedContext(root, SESSION, "Observed parser behavior in test/parser.test.ts; revalidate if parser.ts changes.");
  const returned = readTaskContextReturn({ projectRoot: root, sessionId: SESSION, taskId: TASK, headSha: head });
  assert.deepEqual(returned, {
    version: 1,
    kind: "task-context-return",
    session_id: SESSION,
    task_id: TASK,
    head_sha: head,
    content: "Observed parser behavior in test/parser.test.ts; revalidate if parser.ts changes.",
    sha256: sha256("Observed parser behavior in test/parser.test.ts; revalidate if parser.ts changes."),
  });
  assert.equal(validateTaskContextReturn(returned, { sessionId: SESSION, taskId: TASK, headSha: head }).ok, true);
  assert.equal(validateTaskContextReturn({ ...returned, content: `${returned.content} changed` }, { sessionId: SESSION, taskId: TASK, headSha: head }).ok, false);
  assert.equal(validateTaskContextReturn(returned, { sessionId: "foreign-session", taskId: TASK, headSha: head }).ok, false);
  assert.throws(() => readTaskContextReturn({ projectRoot: root, sessionId: SESSION, taskId: TASK, headSha: "0".repeat(40) }), /HEAD mismatch/);
});

test("task context return rejects foreign state, symlinked diary and oversized snapshots", (t) => {
  const { root, head, stateDir } = fixture(t);
  const statePath = path.join(stateDir, "gate-state.json");
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  fs.writeFileSync(statePath, JSON.stringify({ ...state, task_run: { task_id: "task-two" } }));
  assert.throws(() => readTaskContextReturn({ projectRoot: root, sessionId: SESSION, taskId: TASK, headSha: head }), /state identity mismatch/);

  fs.writeFileSync(statePath, JSON.stringify(state));
  updateSharedContext(root, SESSION, "safe diary");
  const shared = path.join(stateDir, "shared_context.md");
  const outside = path.join(root, "outside.md");
  fs.writeFileSync(outside, "outside");
  fs.unlinkSync(shared);
  fs.symlinkSync(outside, shared);
  assert.throws(() => readTaskContextReturn({ projectRoot: root, sessionId: SESSION, taskId: TASK, headSha: head }), /Unsafe memory file/);

  const oversized = {
    version: 1,
    kind: "task-context-return",
    session_id: SESSION,
    task_id: TASK,
    head_sha: head,
    content: "x".repeat(SHARED_CONTEXT_MAX_BYTES + 1),
    sha256: sha256("x".repeat(SHARED_CONTEXT_MAX_BYTES + 1)),
  };
  assert.equal(validateTaskContextReturn(oversized, { sessionId: SESSION, taskId: TASK, headSha: head }).ok, false);
});

