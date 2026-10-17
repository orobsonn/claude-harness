/** Durable lifecycle for isolated task parents; observation never launches work. */
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  MODEL_PROFILE_ENV,
  MODEL_PROFILE_HASH_ENV,
} from "./model-profile.mjs";
import { startTaskProcess as startSharedTaskProcess } from "../../shared/lib/task-process.mjs";

export {
  writeTaskJson,
  taskProcessIdentity,
  taskGroupMembers,
  exactWorkerPids,
  readTaskProcess,
} from "../../shared/lib/task-process.mjs";

const TASK_WORKER_PATH = fileURLToPath(
  new URL("../bin/pi-task-worker.mjs", import.meta.url),
);

const HEX_256 = /^[0-9a-f]{64}$/;

/** Only immutable profile pointers cross an Orca terminal boundary; never secrets. */
export function validateTaskProfileEnvironment(value) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join("\0") !== [MODEL_PROFILE_ENV, MODEL_PROFILE_HASH_ENV].sort().join("\0") ||
      typeof value[MODEL_PROFILE_ENV] !== "string" || !path.isAbsolute(value[MODEL_PROFILE_ENV]) ||
      typeof value[MODEL_PROFILE_HASH_ENV] !== "string" || !HEX_256.test(value[MODEL_PROFILE_HASH_ENV])) {
    throw new Error("task model profile environment is invalid");
  }
  return {
    [MODEL_PROFILE_ENV]: value[MODEL_PROFILE_ENV],
    [MODEL_PROFILE_HASH_ENV]: value[MODEL_PROFILE_HASH_ENV],
  };
}

/** Render only public assistant text and tool progress from Pi's JSON stream. */
export function renderTaskEventLine(line) {
  try {
    const event = JSON.parse(line);
    if (
      event?.type === "message_update" &&
      event.assistantMessageEvent?.type === "text_delta" &&
      typeof event.assistantMessageEvent.delta === "string"
    )
      return event.assistantMessageEvent.delta;
    if (
      event?.type === "tool_execution_start" &&
      typeof event.toolName === "string"
    )
      return `\n[tool] ${event.toolName}\n`;
    if (
      event?.type === "tool_execution_end" &&
      typeof event.toolName === "string"
    )
      return `[tool] ${event.toolName} ${event.isError ? "failed" : "done"}\n`;
  } catch {
    /* Unknown/non-JSON output is retained in the receipt file, never echoed. */
  }
  return "";
}

/** Called only by the host coordinator. Secrets are never serialized. */
export async function startTaskProcess({ profileEnvironment, ...options }) {
  return startSharedTaskProcess({
    ...options,
    workerPath: TASK_WORKER_PATH,
    jobFields: () => {
      const admittedProfileEnvironment = validateTaskProfileEnvironment(profileEnvironment);
      return admittedProfileEnvironment ? { profile_environment: admittedProfileEnvironment } : {};
    },
  });
}
