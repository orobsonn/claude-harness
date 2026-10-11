/** @description Curated task context snapshots and evidence-backed task context returns. */
import path from "node:path";
import { execFileSync } from "node:child_process";

import { isSafeSessionId, isSafeTaskId } from "../../shared/lib/feature-id.mjs";
import {
  TASK_CONTEXT_MAX_BYTES,
  buildTaskContextHandoff,
  buildTaskContextReturn,
  readBoundedRegularFile,
  validateTaskContextHandoff,
  validateTaskContextReturn as validateSharedTaskContextReturn,
} from "../../shared/lib/task-context.mjs";
import { memoryPaths, readMemory, SHARED_CONTEXT_MAX_BYTES } from "./memory-cycle.mjs";

export { TASK_CONTEXT_MAX_BYTES, validateTaskContextHandoff };
const HEX_40 = /^[a-f0-9]{40}$/;

/** Capture a small, deliberately curated brief and bind it to the current parent diary revision. */
export function captureTaskContext({ projectRoot, sessionId, taskId, content }) {
  return buildTaskContextHandoff({
    parentSessionId: sessionId,
    taskId,
    content,
    readSharedContext: () => readMemory(projectRoot, sessionId).sharedContext,
  });
}

/** Validate a task return before it is copied into a host-owned result or receipt. */
export function validateTaskContextReturn(value, { sessionId, taskId, headSha } = {}) {
  return validateSharedTaskContextReturn(value, { sessionId, taskId, headSha, maxBytes: SHARED_CONTEXT_MAX_BYTES });
}

/** Read only this delegated task session's diary at the exact result HEAD. */
export function readTaskContextReturn({ projectRoot, sessionId, taskId, headSha }) {
  if (!isSafeSessionId(sessionId) || !isSafeTaskId(taskId) || !HEX_40.test(headSha ?? "")) {
    throw new Error("valid task session, task and HEAD required");
  }
  const paths = memoryPaths(projectRoot, sessionId);
  const statePath = path.join(paths.directory, "gate-state.json");
  const state = JSON.parse(readBoundedRegularFile(statePath, 1024 * 1024));
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
  return buildTaskContextReturn({ sessionId, taskId, headSha, content, maxBytes: SHARED_CONTEXT_MAX_BYTES });
}
