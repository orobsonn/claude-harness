/** @description Curated task context snapshots and evidence-backed task context returns. */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

import { isSafeSessionId, isSafeTaskId } from "../../shared/lib/feature-id.mjs";
import { memoryPaths, readMemory, SHARED_CONTEXT_MAX_BYTES } from "./memory-cycle.mjs";

export const TASK_CONTEXT_MAX_BYTES = 2 * 1024;
const HEX_40 = /^[a-f0-9]{40}$/;
const HEX_64 = /^[a-f0-9]{64}$/;
const sha256 = (content) => createHash("sha256").update(content).digest("hex");
const ownKeysAre = (value, expected) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  const expectedKeys = [...expected].sort();
  return keys.length === expectedKeys.length && keys.every((key, index) => key === expectedKeys[index]);
};
const invalid = (reason) => ({ ok: false, reason: `[task-context] ${reason}` });

function readBoundedRegular(file, limit) {
  const info = fs.lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > limit || fs.realpathSync(file) !== file) {
    throw new Error("unsafe task state file");
  }
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const buffer = Buffer.alloc(limit + 1);
    const count = fs.readSync(fd, buffer, 0, buffer.length, 0);
    if (count > limit) throw new Error("task state file exceeds size limit");
    return buffer.subarray(0, count).toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

/** Capture a small, deliberately curated brief and bind it to the current parent diary revision. */
export function captureTaskContext({ projectRoot, sessionId, taskId, content }) {
  if (!isSafeSessionId(sessionId) || !isSafeTaskId(taskId)) throw new Error("valid parent session and task identity required");
  if (typeof content !== "string" || !content.trim() || Buffer.byteLength(content, "utf8") > TASK_CONTEXT_MAX_BYTES) {
    throw new Error("task context must be a non-empty string of at most 2048 UTF-8 bytes");
  }
  const memory = readMemory(projectRoot, sessionId);
  return {
    version: 1,
    kind: "curated-task-context",
    parent_session_id: sessionId,
    task_id: taskId,
    source_shared_context_sha256: memory.sharedContext === null ? null : sha256(memory.sharedContext),
    content_sha256: sha256(content),
    content,
  };
}

/** Validate a grant-embedded curated context against exact parent/task identity and content bytes. */
export function validateTaskContextHandoff(value, { parentSessionId, taskId } = {}) {
  const keys = ["content", "content_sha256", "kind", "parent_session_id", "source_shared_context_sha256", "task_id", "version"];
  if (!ownKeysAre(value, keys)) return invalid("context handoff shape mismatch");
  if (value.version !== 1 || value.kind !== "curated-task-context" ||
      !isSafeSessionId(parentSessionId) || !isSafeTaskId(taskId) ||
      value.parent_session_id !== parentSessionId || value.task_id !== taskId) {
    return invalid("context handoff identity mismatch");
  }
  if (typeof value.content !== "string" || !value.content.trim() || Buffer.byteLength(value.content, "utf8") > TASK_CONTEXT_MAX_BYTES ||
      !HEX_64.test(value.content_sha256 ?? "") || value.content_sha256 !== sha256(value.content) ||
      !(value.source_shared_context_sha256 === null || HEX_64.test(value.source_shared_context_sha256 ?? ""))) {
    return invalid("context handoff hash or byte limit mismatch");
  }
  return { ok: true, snapshot: { ...value } };
}

/** Validate a task return before it is copied into a host-owned result or receipt. */
export function validateTaskContextReturn(value, { sessionId, taskId, headSha } = {}) {
  const keys = ["content", "head_sha", "kind", "session_id", "sha256", "task_id", "version"];
  if (!ownKeysAre(value, keys)) return invalid("context return shape mismatch");
  if (value.version !== 1 || value.kind !== "task-context-return" ||
      !isSafeSessionId(sessionId) || !isSafeTaskId(taskId) || !HEX_40.test(headSha ?? "") ||
      value.session_id !== sessionId || value.task_id !== taskId || value.head_sha !== headSha) {
    return invalid("context return identity mismatch");
  }
  if (typeof value.content !== "string" || Buffer.byteLength(value.content, "utf8") > SHARED_CONTEXT_MAX_BYTES ||
      !HEX_64.test(value.sha256 ?? "") || value.sha256 !== sha256(value.content)) {
    return invalid("context return hash or byte limit mismatch");
  }
  return { ok: true, snapshot: { ...value } };
}

/** Read only this delegated task session's diary at the exact result HEAD. */
export function readTaskContextReturn({ projectRoot, sessionId, taskId, headSha }) {
  if (!isSafeSessionId(sessionId) || !isSafeTaskId(taskId) || !HEX_40.test(headSha ?? "")) {
    throw new Error("valid task session, task and HEAD required");
  }
  const paths = memoryPaths(projectRoot, sessionId);
  const statePath = path.join(paths.directory, "gate-state.json");
  const state = JSON.parse(readBoundedRegular(statePath, 1024 * 1024));
  if (state.session_id !== sessionId || state.task_pipeline_version !== 1 || state.classification_source !== "delegated-task" ||
      state.task_run?.task_id !== taskId) {
    throw new Error("task context return state identity mismatch");
  }
  const currentHead = () => execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: paths.root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  if (currentHead() !== headSha) throw new Error("task context return HEAD mismatch");
  const content = readMemory(paths.root, sessionId).sharedContext;
  if (currentHead() !== headSha) throw new Error("task context return HEAD changed during snapshot");
  if (content === null) return null;
  const snapshot = {
    version: 1,
    kind: "task-context-return",
    session_id: sessionId,
    task_id: taskId,
    head_sha: headSha,
    content,
    sha256: sha256(content),
  };
  const checked = validateTaskContextReturn(snapshot, { sessionId, taskId, headSha });
  if (!checked.ok) throw new Error(checked.reason);
  return snapshot;
}
